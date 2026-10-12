/**
 * The Verification page body (implement/22-console-feedback.md C10): how proof requests ended and how
 * face checks went over the window, under two tabs. Rendered by the tenant portal and by the operator's
 * tenant detail, one set of components and two callers, as the tenant dashboard is. The caller passes
 * its data, its URL search and where its own pages live.
 *
 * Forms, by what the data has to say:
 *   headline numbers      stat tiles, the rate in the sub-line
 *   outcome over time     one stacked column per day, in the status colours (states, not series)
 *   why attempts failed   a ranked bar list; a row filters the table below
 *   how scores spread     ten buckets with the minimum marked on the same scale
 *   the records           the paged table, with the log of each check one click away
 */
import type { LinkProps } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'

import { BarList, OutcomeColumns, type OutcomeSeries, ScoreHistogram } from '@/components/dashboard/charts'
import type { Exporter } from '@/components/data-table/export-menu'
import { DateRangeFilter, MultiFilter, SelectFilter } from '@/components/data-table/list-toolbar'
import { StatGrid, StatTile } from '@/components/dashboard/stat-tile'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { BiometricLogLoader, CustomerOpener } from '@/features/tenant-data/panels'
import { type PageSize, isFiltered, pagingFor, resetFor } from '@/lib/list-search'

import { FaceChecksTable } from './checks-table'
import { attemptsSummary, checkColumns, decidedChecks, finishedProofs, percent, proofColumns } from './verification-format'
import type { ChecksPage, VerificationStats } from './verification.queries'
import { type VerificationSearch, type VerificationTab, checkKindOptions, checkReasonOptions, checkStatusOptions, reasonLabel } from './verification.schemas'

const PROOF_SERIES: OutcomeSeries[] = [
  { key: 'verified', label: 'Verified', color: 'var(--status-good)' },
  { key: 'inFlight', label: 'In flight', color: 'var(--status-warning)' },
  { key: 'notVerified', label: 'Not verified', color: 'var(--status-critical)' },
]

// A cancelled check has no outcome (its exchange was closed first), so it takes the neutral, not a status colour.
const CHECK_SERIES: OutcomeSeries[] = [
  { key: 'passed', label: 'Passed', color: 'var(--status-good)' },
  { key: 'open', label: 'Open', color: 'var(--status-warning)' },
  { key: 'notPassed', label: 'Failed or expired', color: 'var(--status-critical)' },
  { key: 'cancelled', label: 'Cancelled', color: 'var(--chart-4)' },
]

const TAB_LABELS: Record<VerificationTab, string> = { proofs: 'Proofs', checks: 'Face checks' }
/** Filters of the checks list; the window and the tab are not among them. */
const LIST_KEYS = ['q', 'from', 'to', 'status', 'recordType', 'reason', 'page'] as const

export interface VerificationBodyProps {
  stats: VerificationStats
  /** The page of checks for the search; absent while the Proofs tab is open. */
  checks?: ChecksPage
  search: VerificationSearch
  onSearch: (patch: Partial<VerificationSearch> & { page?: number; pageSize?: PageSize }) => void
  fetching?: boolean
  loadBiometricLog: BiometricLogLoader
  onOpenCustomer: CustomerOpener
  /** The tenant's Biometrics page, for the pointer shown when no check has ever run. */
  biometricsLink: Pick<LinkProps, 'to' | 'params'>
  /** Exports the checks list under its filters; omit when the viewer may not export. */
  onExportChecks?: Exporter
}

export function VerificationBody(props: VerificationBodyProps) {
  const { stats, search, onSearch } = props
  const tab = search.tab ?? 'proofs'
  return (
    <div className="space-y-4">
      {/* A tab switch drops the list's filters: they belong to the Face checks tab. */}
      <Tabs value={tab} onValueChange={(next) => onSearch({ ...Object.fromEntries(LIST_KEYS.map((key) => [key, undefined])), tab: next === 'proofs' ? undefined : (next as VerificationTab) })}>
        <TabsList>
          {(['proofs', 'checks'] as const).map((value) => (
            <TabsTrigger key={value} value={value}>
              {TAB_LABELS[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === 'proofs' ? <ProofsTab stats={stats} /> : <ChecksTab {...props} />}
    </div>
  )
}

function ProofsTab({ stats }: { stats: VerificationStats }) {
  const p = stats.proofs
  const finished = finishedProofs(p)
  const ruled = p.conditional.required + p.conditional.notRequired
  return (
    <div className="space-y-4" data-testid="verification-proofs">
      <StatGrid>
        <StatTile testId="stat-proof-requests" label="Proof requests" value={p.requested} sub={`${p.inFlight} still in flight`} />
        <StatTile testId="stat-proof-verified" label="Verified" value={p.verified} sub={`${percent(p.verified, finished)} of the ${finished} that finished`} />
        <StatTile testId="stat-proof-abandoned" label="Abandoned or declined" value={p.abandoned} sub="Declined, never answered, or stopped by a failed face check" />
        <StatTile testId="stat-proof-failed" label="Failed verification" value={p.failed} sub="A presentation arrived and did not verify" />
      </StatGrid>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Outcome per day</CardTitle>
          <CardDescription>Proof requests started each day (UTC) over the last {stats.days} days, by where they stand today.</CardDescription>
        </CardHeader>
        <CardContent>
          <OutcomeColumns data={proofColumns(p.series)} series={PROOF_SERIES} emptyText="No proof requests started in this window." testId="proof-outcome-chart" />
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>By template</CardTitle>
          <CardDescription>
            The busiest proof templates of the window.
            {ruled > 0 && ` Conditional face-check rules asked for a check on ${p.conditional.required} of ${ruled} requests.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {p.templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No proof requests in this window.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="template-outcomes">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-4 font-medium">Template</th>
                    <th className="py-1 pr-4 text-right font-medium">Requests</th>
                    <th className="py-1 pr-4 text-right font-medium">Verified</th>
                    <th className="py-1 pr-4 text-right font-medium">Failed verification</th>
                    <th className="py-1 text-right font-medium">Verified, of requests</th>
                  </tr>
                </thead>
                <tbody>
                  {p.templates.map((row) => (
                    <tr key={row.templateId ?? 'inline'} className="border-t">
                      <td className="py-1 pr-4">{row.name ?? (row.templateId ? 'Deleted template' : 'Requests without a template')}</td>
                      <td className="py-1 pr-4 text-right tabular-nums">{row.requested}</td>
                      <td className="py-1 pr-4 text-right tabular-nums">{row.verified}</td>
                      <td className="py-1 pr-4 text-right tabular-nums">{row.failed}</td>
                      <td className="py-1 text-right tabular-nums">{percent(row.verified, row.requested)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ChecksTab({ stats, checks, search, onSearch, fetching, loadBiometricLog, onOpenCustomer, biometricsLink, onExportChecks }: VerificationBodyProps) {
  const f = stats.faceChecks
  const decided = decidedChecks(f.byStatus)
  const passedIn = attemptsSummary(f.attemptsToPass)
  const listSearch = { q: search.q, from: search.from, to: search.to, status: search.status, recordType: search.recordType, reason: search.reason }

  return (
    <div className="space-y-4" data-testid="verification-checks">
      {f.total === 0 && !f.enabled && (
        <Card size="sm" data-testid="checks-off">
          <CardHeader>
            <CardTitle>Face checks are switched off</CardTitle>
            <CardDescription>
              No exchange of this tenant asks for a liveness and face-match check, so there is nothing to show for this window.{' '}
              <Link {...biometricsLink} className="underline">
                Biometrics
              </Link>{' '}
              has the provider and the policy.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <StatGrid>
        <StatTile testId="stat-checks" label="Face checks" value={f.total} sub={`${f.issuance.passed + f.issuance.failed + f.issuance.expired + f.issuance.pending + f.issuance.cancelled} for issuance · ${f.proofs.passed + f.proofs.failed + f.proofs.expired + f.proofs.pending + f.proofs.cancelled} for proofs`} />
        <StatTile testId="stat-checks-passed" label="Passed" value={f.byStatus.passed} sub={`${percent(f.byStatus.passed, decided)} of the ${decided} decided`} />
        <StatTile testId="stat-checks-failed" label="Failed" value={f.byStatus.failed} sub="Every attempt was turned down" />
        <StatTile testId="stat-checks-expired" label="Expired" value={f.byStatus.expired} sub={`${f.byStatus.pending} open · ${f.byStatus.cancelled} cancelled`} />
      </StatGrid>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Checks per day</CardTitle>
          <CardDescription>Face checks started each day (UTC) over the last {stats.days} days, by where they stand today.</CardDescription>
        </CardHeader>
        <CardContent>
          <OutcomeColumns data={checkColumns(f.series)} series={CHECK_SERIES} emptyText="No face checks started in this window." testId="check-outcome-chart" />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Why attempts were turned down</CardTitle>
            <CardDescription>
              {f.attempts.total} attempt{f.attempts.total === 1 ? '' : 's'} in the window, {f.attempts.rejected} turned down. A person may try again, so one check can count more than once. Choose a reason to list its checks.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {f.reasons.length === 0 ? (
              <p className="text-sm text-muted-foreground">No attempt was turned down.</p>
            ) : (
              <BarList rows={f.reasons.map((row) => ({ key: row.reason, label: reasonLabel(row.reason), value: row.attempts }))} selected={search.reason} onSelect={(reason) => onSearch({ reason })} testId="rejection-reasons" />
            )}
            {passedIn && (
              <p className="text-xs text-muted-foreground" data-testid="attempts-to-pass">
                Checks that passed, by attempts needed: {passedIn}.
              </p>
            )}
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>Scores</CardTitle>
            <CardDescription>
              Every scored attempt of the window, 0 to 100, against the minimum of the tenant's default policy (a template or a credential definition may set its own). Scores removed by erasure or the retention period are not counted.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 sm:grid-cols-2">
            <ScoreHistogram buckets={f.scores.liveness} threshold={f.thresholds.minLivenessScore} label="Liveness" testId="liveness-scores" />
            <ScoreHistogram buckets={f.scores.match} threshold={f.thresholds.minMatchScore} label="Face match" testId="match-scores" />
          </CardContent>
        </Card>
      </div>

      {checks && (
        <FaceChecksTable
          rows={checks.items}
          paging={pagingFor(checks, onSearch)}
          search={{ value: search.q, placeholder: 'Search external id', onChange: (q) => onSearch({ q }) }}
          onReset={resetFor(listSearch, onSearch)}
          fetching={fetching}
          emptyMessage={isFiltered(listSearch) ? 'No face checks match.' : 'No face checks yet.'}
          loadBiometricLog={loadBiometricLog}
          onOpenCustomer={onOpenCustomer}
          onExport={onExportChecks}
          toolbar={
            <>
              <MultiFilter label="Outcome" options={checkStatusOptions} value={search.status} onChange={(status) => onSearch({ status })} testId="check-status-filter" />
              <SelectFilter label="For" options={checkKindOptions} value={search.recordType} onChange={(recordType) => onSearch({ recordType })} />
              <SelectFilter
                label="Reason"
                // A reason biometric-service adds later still shows as chosen.
                options={search.reason && !checkReasonOptions.some((option) => option.value === search.reason) ? [...checkReasonOptions, { value: search.reason, label: reasonLabel(search.reason) }] : checkReasonOptions}
                value={search.reason}
                onChange={(reason) => onSearch({ reason })}
                testId="check-reason-filter"
              />
              <DateRangeFilter label="Started" from={search.from} to={search.to} onChange={(range) => onSearch(range)} />
            </>
          }
        />
      )}
    </div>
  )
}
