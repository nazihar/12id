/**
 * The customer page body (implement/22-console-feedback.md C11): everything on one connection. The
 * numbers on top come from one aggregate call; below them the credential exchanges, proof exchanges
 * and face checks are the same paged tables as elsewhere, narrowed to this connection. Rendered by
 * the tenant portal and by the operator's tenant detail.
 *
 * A customer is a connection, because that is what the exchanges hang on. Wallets do not: the
 * mediator keeps a wallet and its connections apart, so the wallets shown are the ones the tenant
 * registered with the same external id, and the page says so.
 */
import { DateRangeFilter, MultiFilter } from '@/components/data-table/list-toolbar'
import { StatGrid, StatTile } from '@/components/dashboard/stat-tile'
import { StateBadge } from '@/components/state-badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Eraser } from '@/features/tenant-data/data-protection'
import { type BiometricLogLoader, ExchangeLists } from '@/features/tenant-data/panels'
import { formatDateTime } from '@/lib/format'
import { type PageSize, isFiltered, pagingFor, resetFor } from '@/lib/list-search'

import { FaceChecksTable } from './checks-table'
import { percent } from './verification-format'
import type { CustomerActivity, CustomerRecords } from './verification.queries'
import { CUSTOMER_TABS, type CustomerSearch, type CustomerTab, checkStatusOptions } from './verification.schemas'

const TAB_LABELS: Record<CustomerTab, string> = { credentials: 'Credential exchanges', proofs: 'Proof exchanges', checks: 'Face checks' }

/** What the page calls the person: the tenant's own reference, else the label the wallet gave, else the connection. */
export const customerTitle = (connection: CustomerActivity['connection']) => connection.externalId ?? connection.theirLabel ?? `Connection ${connection.id.slice(0, 8)}`

export function CustomerBody({
  activity,
  records,
  search,
  onSearch,
  fetching,
  loadBiometricLog,
  eraser,
}: {
  activity: CustomerActivity
  records: CustomerRecords
  search: CustomerSearch
  onSearch: (patch: Partial<CustomerSearch> & { page?: number; pageSize?: PageSize }) => void
  fetching?: boolean
  loadBiometricLog: BiometricLogLoader
  /** Omit when the viewer may not erase personal data. */
  eraser?: Eraser
}) {
  const { credentials, proofs, faceChecks, wallets, connection } = activity
  const tab = search.tab ?? 'credentials'
  const loading = records.tab !== tab
  const checkCount = (status: string) => faceChecks.byStatus[status] ?? 0
  const filters = { from: search.from, to: search.to, state: search.state }

  return (
    <div className="space-y-4">
      <StatGrid>
        <StatTile testId="stat-customer-credentials" label="Credentials issued" value={credentials.byState.done ?? 0} sub={`${credentials.total} exchange${credentials.total === 1 ? '' : 's'}`} />
        <StatTile testId="stat-customer-proofs" label="Proofs verified" value={proofs.verified} sub={`${percent(proofs.verified, proofs.total)} of ${proofs.total} requests · ${proofs.failed} failed verification`} />
        <StatTile testId="stat-customer-checks" label="Face checks passed" value={checkCount('passed')} sub={`${checkCount('failed')} failed · ${checkCount('expired')} expired · ${faceChecks.total} in all`} />
        <StatTile testId="stat-customer-activity" label="Last activity" value={<span className="text-base">{formatDateTime(activity.lastActivityAt)}</span>} sub={`Connected ${formatDateTime(connection.createdAt)}`} />
      </StatGrid>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Wallets with the same external id</CardTitle>
          <CardDescription>
            {connection.externalId
              ? 'App installations registered under this reference. A wallet is not linked to a connection, so this is a match by your own reference, not something the platform established.'
              : 'This connection has no external id, so no wallet can be matched to it.'}
          </CardDescription>
        </CardHeader>
        {connection.externalId && (
          <CardContent>
            {wallets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No wallet is registered under this external id.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="customer-wallets">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-4 font-medium">Wallet</th>
                      <th className="py-1 pr-4 font-medium">Status</th>
                      <th className="py-1 pr-4 font-medium">Created</th>
                      <th className="py-1 font-medium">First connected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallets.map((wallet) => (
                      <tr key={wallet.id} className="border-t">
                        <td className="py-1 pr-4 font-mono text-xs">{wallet.id}</td>
                        <td className="py-1 pr-4">
                          <StateBadge state={wallet.revokedAt ? 'revoked' : 'active'} />
                        </td>
                        <td className="py-1 pr-4 whitespace-nowrap">{formatDateTime(wallet.createdAt)}</td>
                        <td className="py-1 whitespace-nowrap">{wallet.connectedAt ? formatDateTime(wallet.connectedAt) : 'never'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Each tab has its own states, so a tab switch drops the filters. */}
      <Tabs value={tab} onValueChange={(next) => onSearch({ tab: next === 'credentials' ? undefined : (next as CustomerTab), state: undefined, from: undefined, to: undefined })}>
        <TabsList>
          {CUSTOMER_TABS.map((value) => (
            <TabsTrigger key={value} value={value}>
              {TAB_LABELS[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : records.tab === 'checks' ? (
        <FaceChecksTable
          rows={records.page.items}
          paging={pagingFor(records.page, onSearch)}
          onReset={resetFor(filters, onSearch)}
          fetching={fetching}
          emptyMessage={isFiltered(filters) ? 'No face checks match.' : 'No face checks on this connection.'}
          loadBiometricLog={loadBiometricLog}
          toolbar={
            <>
              <MultiFilter label="Outcome" options={checkStatusOptions} value={search.state as (typeof checkStatusOptions)[number]['value'][] | undefined} onChange={(state) => onSearch({ state })} testId="check-status-filter" />
              <DateRangeFilter label="Started" from={search.from} to={search.to} onChange={(range) => onSearch(range)} />
            </>
          }
        />
      ) : (
        <ExchangeLists data={records} search={{ ...search, tab: records.tab }} onSearch={({ tab: _tab, q: _q, ...patch }) => onSearch(patch)} fetching={fetching} loadBiometricLog={loadBiometricLog} eraser={eraser} showTabs={false} searchBox={false} />
      )}
    </div>
  )
}
