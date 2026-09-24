/**
 * Tenant data views shared by the operator console and the tenant portal. Each takes plain data or
 * callbacks, so the same UI runs over operator server functions (tenant named per call) and portal
 * server functions (tenant from the active organization).
 */
import { type QueryKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { EyeIcon, KeyRoundIcon, RotateCwIcon, ScanFaceIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { DateRangeFilter, MultiFilter, SelectFilter } from '@/components/data-table/list-toolbar'
import { PageHeader } from '@/components/page-header'
import { RowAction, RowActions } from '@/components/row-action'
import { StateBadge } from '@/components/state-badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDateTime } from '@/lib/format'
import { type Page, type PageSize, isFiltered, pagingFor, resetFor } from '@/lib/list-search'

import { CreateApiKeyDialog } from './create-api-key-dialog'
import {
  type ApiKeySearch,
  type DeliverySearch,
  EXCHANGE_STATES,
  EXCHANGE_TABS,
  type ExchangeSearch,
  type ExchangeTab,
  type WalletSearch,
  activeRevokedOptions,
  deliveryStatusOptions,
  eventTypeOptions,
  stateOptions,
} from './list.schemas'
import type { ApiKeyRow, BiometricLog, BiometricLogEvent, ConnectionRow, CredentialRow, DeliveryDetail, DeliveryRow, ExchangeKind, ProofRow, WalletRow } from './types'

/** A server-paged list: one page, its URL search, and a way to change that search. */
export interface ListProps<TData, TSearch> {
  data: TData
  search: TSearch
  onSearch: (patch: Partial<TSearch> & { page?: number; pageSize?: PageSize }) => void
  fetching?: boolean
}

const mono = (value: string | null) => <span className="font-mono text-xs">{value ?? '—'}</span>

// --- exchanges ----------------------------------------------------------------------------

const connectionColumn = createColumnHelper<DataTableFeatures, ConnectionRow>()
const connectionColumns = connectionColumn.columns([
  connectionColumn.accessor('theirLabel', { header: 'Holder label', cell: ({ getValue }) => getValue() ?? '—' }),
  connectionColumn.accessor('state', { header: 'State', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
  connectionColumn.accessor('externalId', { header: 'External id', cell: ({ getValue }) => mono(getValue()) }),
  connectionColumn.accessor('id', { header: 'Connection', cell: ({ getValue }) => mono(getValue()) }),
  connectionColumn.accessor('updatedAt', { header: 'Updated', cell: ({ getValue }) => formatDateTime(getValue()) }),
])

type Biometric = CredentialRow['biometric']
/** Loads one exchange's biometric log (Phase 6); each read is audited by platform-api. */
export type BiometricLogLoader = (kind: ExchangeKind, id: string) => Promise<BiometricLog>

/** Status badge plus the last match score; a dash when the exchange was not gated. */
function BiometricCell({ biometric }: { biometric: Biometric }) {
  if (!biometric) return <span className="text-muted-foreground">—</span>
  return (
    <span className="flex items-center gap-2" data-testid="biometric-cell">
      <StateBadge state={biometric.status} />
      {biometric.matchScore !== null && <span className="font-mono text-xs text-muted-foreground">match {biometric.matchScore.toFixed(1)}</span>}
    </span>
  )
}

const credentialColumn = createColumnHelper<DataTableFeatures, CredentialRow>()
function credentialColumnsWith(onLog?: (id: string) => void) {
  return credentialColumn.columns([
    credentialColumn.accessor('externalId', { header: 'External id', cell: ({ getValue }) => mono(getValue()) }),
    credentialColumn.accessor('state', { header: 'State', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
    credentialColumn.accessor('biometric', { header: 'Biometric', cell: ({ getValue }) => <BiometricCell biometric={getValue()} /> }),
    credentialColumn.accessor('credentialDefinitionId', { header: 'Credential definition', cell: ({ getValue }) => mono(getValue()) }),
    credentialColumn.accessor('errorMessage', { header: 'Error', cell: ({ getValue }) => getValue() ?? '' }),
    credentialColumn.accessor('updatedAt', { header: 'Updated', cell: ({ getValue }) => formatDateTime(getValue()) }),
    credentialColumn.display({
      id: 'actions',
      header: '',
      cell: ({ row }) => (onLog && row.original.biometric ? <RowActions><RowAction label="Biometric log" icon={ScanFaceIcon} onClick={() => onLog(row.original.id)} /></RowActions> : null),
    }),
  ])
}

const proofColumn = createColumnHelper<DataTableFeatures, ProofRow>()
function proofColumnsWith(onLog?: (id: string) => void) {
  return proofColumn.columns([
    proofColumn.accessor('externalId', { header: 'External id', cell: ({ getValue }) => mono(getValue()) }),
    proofColumn.accessor('state', { header: 'State', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
    proofColumn.accessor('biometric', { header: 'Biometric', cell: ({ getValue }) => <BiometricCell biometric={getValue()} /> }),
    proofColumn.accessor('verified', { header: 'Verified', cell: ({ getValue }) => (getValue() === null ? '—' : getValue() ? 'yes' : 'no') }),
    // Attribute names only: disclosed values are personal data.
    proofColumn.accessor((row) => Object.entries(row.disclosed ?? {}).map(([group, values]) => `${group}: ${Object.keys(values).join(', ')}`).join(' · '), { id: 'disclosed', header: 'Disclosed attributes' }),
    proofColumn.accessor('updatedAt', { header: 'Updated', cell: ({ getValue }) => formatDateTime(getValue()) }),
    proofColumn.display({
      id: 'actions',
      header: '',
      cell: ({ row }) => (onLog && row.original.biometric ? <RowActions><RowAction label="Biometric log" icon={ScanFaceIcon} onClick={() => onLog(row.original.id)} /></RowActions> : null),
    }),
  ])
}

/** One page of the exchange kind the tab names, as the list server function returns it. */
export type ExchangePage = { tab: 'connections'; page: Page<ConnectionRow> } | { tab: 'credentials'; page: Page<CredentialRow> } | { tab: 'proofs'; page: Page<ProofRow> }

const TAB_LABELS: Record<ExchangeTab, string> = { connections: 'Connections', credentials: 'Credential exchanges', proofs: 'Proof exchanges' }

/**
 * Connections, credential exchanges and proof exchanges as three tabs (Phase 4 C9), each paged on
 * the server with its own external-id search, state filter and created-date range in the URL.
 */
export function ExchangeLists({ data, search, onSearch, fetching, loadBiometricLog }: ListProps<ExchangePage, ExchangeSearch> & { loadBiometricLog?: BiometricLogLoader }) {
  const [viewing, setViewing] = useState<{ kind: ExchangeKind; id: string } | null>(null)
  const credentialColumns = useMemo(() => credentialColumnsWith(loadBiometricLog ? (id) => setViewing({ kind: 'credential', id }) : undefined), [loadBiometricLog])
  const proofColumns = useMemo(() => proofColumnsWith(loadBiometricLog ? (id) => setViewing({ kind: 'proof', id }) : undefined), [loadBiometricLog])
  const tab = search.tab ?? 'connections'
  // While another tab loads, the previous tab's rows must not render under the new tab's columns.
  const loading = data.tab !== tab
  const empty = (noun: string) => (isFiltered(search) ? `No ${noun} match.` : `No ${noun}.`)
  const common = {
    paging: pagingFor(data.page, onSearch),
    onReset: resetFor(search, onSearch),
    search: { value: search.q, placeholder: tab === 'connections' ? 'Search external id or holder label' : 'Search external id', onChange: (q: string | undefined) => onSearch({ q }) },
    fetching,
    toolbar: (
      <>
        <MultiFilter label="State" options={stateOptions(EXCHANGE_STATES[tab])} value={search.state} onChange={(state) => onSearch({ state })} testId="state-filter" />
        <DateRangeFilter from={search.from} to={search.to} onChange={(range) => onSearch(range)} />
      </>
    ),
  }
  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={(next) => onSearch({ tab: next === 'connections' ? undefined : (next as ExchangeTab), q: undefined, state: undefined, from: undefined, to: undefined })}>
        <TabsList>
          {EXCHANGE_TABS.map((value) => (
            <TabsTrigger key={value} value={value}>
              {TAB_LABELS[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data.tab === 'connections' ? (
        <DataTable columns={connectionColumns} data={data.page.items} emptyMessage={empty('connections')} testId="connections-table" {...common} />
      ) : data.tab === 'credentials' ? (
        <DataTable columns={credentialColumns} data={data.page.items} emptyMessage={empty('credential exchanges')} testId="credentials-table" {...common} />
      ) : (
        <DataTable columns={proofColumns} data={data.page.items} emptyMessage={empty('proof exchanges')} testId="proofs-table" {...common} />
      )}
      {loadBiometricLog && <BiometricLogDialog target={viewing} load={loadBiometricLog} onClose={() => setViewing(null)} />}
    </div>
  )
}

const EVENT_LABELS: Record<string, string> = {
  gate_created: 'Check required',
  session_started: 'Capture started',
  attempt_completed: 'Attempt decided',
  hold_reached: 'Holder answered; held',
  issued: 'Credential issued',
  accepted: 'Presentation accepted',
  declined: 'Exchange abandoned',
  expired: 'Check expired',
  cancelled: 'Check cancelled',
}

const score = (value: number | null, threshold: number | undefined) =>
  value === null ? '—' : `${value.toFixed(1)}${threshold === undefined ? '' : ` / ${threshold}`}`

/**
 * The biometric log of one exchange (Phase 6): every step with scores against the thresholds and the
 * vendor session id for cross-checking in the organisation's vendor account. Never shows images.
 */
function BiometricLogDialog({ target, load, onClose }: { target: { kind: ExchangeKind; id: string } | null; load: BiometricLogLoader; onClose: () => void }) {
  const log = useQuery({
    queryKey: ['biometric-log', target?.kind, target?.id],
    queryFn: () => load(target!.kind, target!.id),
    enabled: target !== null,
  })
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto overscroll-contain grid-cols-[minmax(0,1fr)] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Biometric log</DialogTitle>
          <DialogDescription>
            Liveness and face-match steps for this {target?.kind === 'proof' ? 'proof' : 'credential'} exchange, oldest first. Scores are 0–100 against the policy's minimum. No images are kept. Opening this log is audited.
          </DialogDescription>
        </DialogHeader>
        {log.error ? (
          <p className="text-sm text-destructive">{log.error.message}</p>
        ) : !log.data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3" data-testid="biometric-log">
            {log.data.biometric && (
              <p className="flex items-center gap-2 text-sm">
                <StateBadge state={log.data.biometric.status} />
                <span>
                  {log.data.biometric.attempts} attempt{log.data.biometric.attempts === 1 ? '' : 's'}
                  {log.data.biometric.reason ? ` · ${log.data.biometric.reason}` : ''}
                </span>
              </p>
            )}
            <div className="min-w-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2 font-medium whitespace-nowrap">Time</th>
                    <th className="py-1 pr-2 font-medium whitespace-nowrap">Step</th>
                    <th className="py-1 pr-2 font-medium whitespace-nowrap">Attempt</th>
                    <th className="py-1 pr-2 font-medium whitespace-nowrap">Liveness</th>
                    <th className="py-1 pr-2 font-medium whitespace-nowrap">Match</th>
                    <th className="py-1 pr-2 font-medium whitespace-nowrap">Decision</th>
                    <th className="py-1 font-medium whitespace-nowrap">Vendor session</th>
                  </tr>
                </thead>
                <tbody>
                  {log.data.events.map((event: BiometricLogEvent) => (
                    <tr key={event.id} className="border-t">
                      <td className="py-1 pr-2 whitespace-nowrap">{formatDateTime(event.at)}</td>
                      <td className="py-1 pr-2 whitespace-nowrap">{EVENT_LABELS[event.type] ?? event.type}</td>
                      <td className="py-1 pr-2 whitespace-nowrap">{event.attempt ?? ''}</td>
                      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">{event.type === 'attempt_completed' ? score(event.livenessScore, event.thresholds?.minLivenessScore) : ''}</td>
                      <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">{event.type === 'attempt_completed' ? score(event.matchScore, event.thresholds?.minMatchScore) : ''}</td>
                      <td className="py-1 pr-2">{event.decision ? <StateBadge state={event.decision} /> : null}{event.reason && event.reason !== 'passed' ? <span className="block text-xs whitespace-nowrap text-muted-foreground">{event.reason}</span> : null}</td>
                      <td className="py-1 whitespace-nowrap">{event.vendorSessionId ? mono(event.vendorSessionId) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// --- wallets ------------------------------------------------------------------------------

const walletColumn = createColumnHelper<DataTableFeatures, WalletRow>()
const walletColumns = walletColumn.columns([
  walletColumn.accessor('externalId', { header: 'External id', cell: ({ getValue }) => mono(getValue()) }),
  walletColumn.accessor((row) => (row.revokedAt ? 'revoked' : 'active'), { id: 'status', header: 'Status', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
  walletColumn.accessor('hasMediatorInvitation', { header: 'Mediator invitation', cell: ({ getValue }) => (getValue() ? 'issued' : 'not yet') }),
  walletColumn.accessor('lastSyncRequestedAt', { header: 'Last wake-up', cell: ({ getValue }) => formatDateTime(getValue()) }),
  walletColumn.accessor('createdAt', { header: 'Created', cell: ({ getValue }) => formatDateTime(getValue()) }),
])

export function WalletsTable({ data, search, onSearch, fetching }: ListProps<Page<WalletRow>, WalletSearch>) {
  return (
    <DataTable
      columns={walletColumns}
      data={data.items}
      paging={pagingFor(data, onSearch)}
      onReset={resetFor(search, onSearch)}
      search={{ value: search.q, placeholder: 'Search external id', onChange: (q) => onSearch({ q }) }}
      toolbar={
        <>
          <SelectFilter label="Status" options={activeRevokedOptions} value={search.status} onChange={(status) => onSearch({ status })} />
          <DateRangeFilter from={search.from} to={search.to} onChange={(range) => onSearch(range)} />
        </>
      }
      fetching={fetching}
      emptyMessage={isFiltered(search) ? 'No wallets match.' : 'No wallets.'}
      testId="wallets-table"
    />
  )
}

// --- API keys -----------------------------------------------------------------------------

const keyColumn = createColumnHelper<DataTableFeatures, ApiKeyRow>()

export function ApiKeysPanel({
  data,
  search,
  onSearch,
  fetching,
  invalidateKey,
  createKey,
  revokeKey,
}: ListProps<Page<ApiKeyRow>, ApiKeySearch> & {
  invalidateKey: QueryKey
  /** Omit when the viewer may not create keys. */
  createKey?: (label: string) => Promise<{ apiKey: string }>
  /** Omit when the viewer may not revoke keys. */
  revokeKey?: (apiKeyId: string) => Promise<unknown>
}) {
  const columns = keyColumn.columns([
    keyColumn.accessor('label', { header: 'Label' }),
    keyColumn.accessor('prefix', { header: 'Key', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}…</span> }),
    keyColumn.accessor((row) => (row.revokedAt ? 'revoked' : 'active'), { id: 'status', header: 'Status', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
    keyColumn.accessor('createdAt', { header: 'Created', cell: ({ getValue }) => formatDateTime(getValue()) }),
    keyColumn.accessor('lastUsedAt', { header: 'Last used', cell: ({ getValue }) => formatDateTime(getValue()) }),
    keyColumn.display({
      id: 'actions',
      header: '',
      cell: ({ row }) => (row.original.revokedAt || !revokeKey ? null : <RevokeKeyAction apiKey={row.original} revoke={() => revokeKey(row.original.id)} invalidateKey={invalidateKey} />),
    }),
  ])

  return (
    <section className="space-y-4">
      <PageHeader
        title="API keys"
        description="Your backend calls the 12id API with these keys (Authorization: Bearer). Never put a key in an app."
        actions={createKey && <CreateApiKeyDialog createKey={createKey} invalidateKey={invalidateKey} />}
      />
      <DataTable
        columns={columns}
        data={data.items}
        paging={pagingFor(data, onSearch)}
        onReset={resetFor(search, onSearch)}
        search={{ value: search.q, placeholder: 'Search label or key prefix', onChange: (q) => onSearch({ q }) }}
        toolbar={<SelectFilter label="Status" options={activeRevokedOptions} value={search.status} onChange={(status) => onSearch({ status })} />}
        fetching={fetching}
        emptyMessage={isFiltered(search) ? 'No API keys match.' : 'No API keys.'}
        testId="api-keys-table"
      />
    </section>
  )
}

function RevokeKeyAction({ apiKey, revoke, invalidateKey }: { apiKey: ApiKeyRow; revoke: () => Promise<unknown>; invalidateKey: QueryKey }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: revoke,
    onSuccess: async () => {
      toast.success(`Revoked ${apiKey.label}. Requests with it now fail.`)
      await queryClient.invalidateQueries({ queryKey: invalidateKey })
    },
  })
  return (
    <RowActions>
      <RowAction
        label="Revoke"
        icon={KeyRoundIcon}
        confirm={{
          title: `Revoke ${apiKey.label}?`,
          description: `Requests with the key ${apiKey.prefix}… fail immediately. This cannot be undone; create a new key for the system that used it.`,
          confirmLabel: 'Revoke key',
          pendingLabel: 'Revoking…',
          destructive: true,
          onConfirm: () => mutation.mutateAsync(),
        }}
      />
    </RowActions>
  )
}

// --- webhook deliveries -------------------------------------------------------------------

const deliveryColumn = createColumnHelper<DataTableFeatures, DeliveryRow>()

export function DeliveriesPanel({
  data,
  search,
  onSearch,
  fetching,
  invalidateKey,
  loadBody,
  retryDelivery,
}: ListProps<Page<DeliveryRow>, DeliverySearch> & {
  invalidateKey: QueryKey
  loadBody: (deliveryId: number) => Promise<DeliveryDetail>
  /** Omit when the viewer may not retry. */
  retryDelivery?: (deliveryId: number) => Promise<unknown>
}) {
  const [viewing, setViewing] = useState<number | null>(null)

  const columns = deliveryColumn.columns([
    deliveryColumn.accessor('eventType', { header: 'Event' }),
    deliveryColumn.accessor('status', { header: 'Status', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
    deliveryColumn.accessor('attempts', { header: 'Attempts' }),
    deliveryColumn.accessor((row) => row.lastError ?? (row.lastStatusCode ? `HTTP ${row.lastStatusCode}` : ''), { id: 'lastResult', header: 'Last result' }),
    deliveryColumn.accessor('createdAt', { header: 'Created', cell: ({ getValue }) => formatDateTime(getValue()) }),
    deliveryColumn.display({
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <RowActions>
          <RowAction label="View body" icon={EyeIcon} onClick={() => setViewing(row.original.id)} />
          {retryDelivery && (row.original.status === 'dead' || row.original.status === 'pending') && <RetryDeliveryAction delivery={row.original} retry={() => retryDelivery(row.original.id)} invalidateKey={invalidateKey} />}
        </RowActions>
      ),
    }),
  ])

  return (
    <section className="space-y-4">
      <PageHeader level={2} title="Deliveries" description="Each event sent to the endpoint, with its result. Bodies open on demand and each read is audited." />
      <DataTable
        columns={columns}
        data={data.items}
        paging={pagingFor(data, onSearch)}
        onReset={resetFor(search, onSearch)}
        fetching={fetching}
        emptyMessage={isFiltered(search) ? 'No deliveries match.' : 'No deliveries.'}
        testId="deliveries-table"
        toolbar={
          <>
            <SelectFilter label="Status" options={deliveryStatusOptions} value={search.status} onChange={(status) => onSearch({ status })} testId="status-filter" />
            <SelectFilter label="Event" options={eventTypeOptions} value={search.eventType} onChange={(eventType) => onSearch({ eventType })} />
            <DateRangeFilter from={search.from} to={search.to} onChange={(range) => onSearch(range)} />
          </>
        }
      />
      <DeliveryBodyDialog deliveryId={viewing} invalidateKey={invalidateKey} loadBody={loadBody} onClose={() => setViewing(null)} />
    </section>
  )
}

function RetryDeliveryAction({ delivery, retry, invalidateKey }: { delivery: DeliveryRow; retry: () => Promise<unknown>; invalidateKey: QueryKey }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: retry,
    onSuccess: async () => {
      toast.success('Queued for another attempt.')
      await queryClient.invalidateQueries({ queryKey: invalidateKey })
    },
  })
  return (
    <RowAction
      label="Retry"
      icon={RotateCwIcon}
      confirm={{
        title: `Retry delivery ${delivery.id}?`,
        description: `The ${delivery.eventType} event is sent again to the endpoint, with the same signed body.`,
        confirmLabel: 'Retry',
        onConfirm: () => mutation.mutateAsync(),
      }}
    />
  )
}

function DeliveryBodyDialog({ deliveryId, invalidateKey, loadBody, onClose }: { deliveryId: number | null; invalidateKey: QueryKey; loadBody: (id: number) => Promise<DeliveryDetail>; onClose: () => void }) {
  // Loaded only when opened: the body carries credential attributes and each read is audited.
  const delivery = useQuery({
    queryKey: [...invalidateKey, 'body', deliveryId],
    queryFn: () => loadBody(deliveryId as number),
    enabled: deliveryId !== null,
    staleTime: 0,
    gcTime: 0,
  })
  let pretty = ''
  if (delivery.data) {
    try {
      pretty = JSON.stringify(JSON.parse(delivery.data.body), null, 2)
    } catch {
      pretty = delivery.data.body
    }
  }
  return (
    <Dialog open={deliveryId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto overscroll-contain sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Delivery {deliveryId}</DialogTitle>
          <DialogDescription>The signed body as sent. It may contain personal data; this view is recorded in the audit log.</DialogDescription>
        </DialogHeader>
        {delivery.error ? (
          <p className="text-sm text-destructive">{delivery.error.message}</p>
        ) : (
          <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{delivery.isPending ? 'Loading…' : pretty}</pre>
        )}
      </DialogContent>
    </Dialog>
  )
}
