import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { CircleAlertIcon, CircleCheckIcon, PauseCircleIcon, TriangleAlertIcon } from 'lucide-react'

import { type AttentionItem, AttentionList } from '@/components/dashboard/attention-list'
import { ActivityChart } from '@/components/dashboard/charts'
import { RangeTabs } from '@/components/dashboard/range-tabs'
import { StatGrid, StatTile } from '@/components/dashboard/stat-tile'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { StateBadge } from '@/components/state-badge'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type OperatorDashboard, operatorDashboardQuery } from '@/features/dashboard/dashboard.queries'
import { parseDashboardSearch, rangeOf } from '@/features/dashboard/dashboard.schemas'
import { auditAction, auditResult } from '@/features/ops/audit-events'
import { CHECK_LABELS } from '@/features/ops/health-format'
import { percent } from '@/features/verification/verification-format'
import { auditLogQuery } from '@/features/ops/ops.queries'
import { formatDateTime } from '@/lib/format'

// The operator dashboard (Phase 4 C8): platform totals, service health, activity, what needs a
// person, the busiest tenants and the latest console actions.
export const Route = createFileRoute('/_authed/ops/')({
  validateSearch: parseDashboardSearch,
  loaderDeps: ({ search }) => ({ days: rangeOf(search) }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(operatorDashboardQuery(deps.days)),
  errorComponent: RouteError,
  component: OperatorDashboardPage,
})

function HealthStrip({ health }: { health: OperatorDashboard['health'] }) {
  const checks = Object.entries(health.checks)
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="health-strip">
      {checks.length === 0 && <span className="text-sm text-muted-foreground">No health checks reported.</span>}
      {checks.map(([name, ok]) => (
        <Badge key={name} variant={ok ? 'secondary' : 'destructive'} className="gap-1">
          {ok ? <CircleCheckIcon className="size-3" aria-hidden /> : <CircleAlertIcon className="size-3" aria-hidden />}
          {CHECK_LABELS[name] ?? name}: {ok ? 'ok' : 'failing'}
        </Badge>
      ))}
      {health.draining && (
        <Badge variant="outline" className="gap-1">
          <PauseCircleIcon className="size-3" aria-hidden />
          platform-api draining
        </Badge>
      )}
      {/* What monitoring reports (implement/22 C16); the list is on the System health page. */}
      {health.alertsFiring > 0 && (
        <Badge variant="destructive" className="gap-1" data-testid="alerts-firing-count">
          <TriangleAlertIcon className="size-3" aria-hidden />
          {health.alertsFiring} alert{health.alertsFiring === 1 ? '' : 's'} firing
        </Badge>
      )}
      <Link to="/ops/health" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        System health
      </Link>
    </div>
  )
}

function attentionItems(stats: OperatorDashboard): AttentionItem[] {
  const a = stats.attention
  return [
    { key: 'failed-tenants', label: 'Tenants whose onboarding failed', detail: a.failedTenants.map((t) => t.name).join(', ') || undefined, count: a.failedTenants.length, level: 'critical', to: '/ops/tenants' },
    { key: 'dead-deliveries', label: 'Dead webhook deliveries', detail: 'Across all tenants; retry from the delivery log.', count: a.deadDeliveries, level: 'critical', to: '/ops/deliveries' },
    { key: 'stuck-credentials', label: 'Credential exchanges stuck for over a day', detail: 'Reconciliation abandons them after its TTL; the customer must re-offer.', count: a.stuckCredentials, level: 'warning' },
    { key: 'stuck-proofs', label: 'Proof exchanges stuck for over a day', count: a.stuckProofs, level: 'warning' },
    { key: 'wallets-never-connected', label: 'Wallets that never reached the mediator', detail: 'Over a day old with no mediator connection.', count: a.walletsNeverConnected, level: 'warning' },
    { key: 'tenants-without-webhook', label: 'Tenants without a webhook endpoint', detail: 'Their events are computed and dropped.', count: a.tenantsWithoutWebhook, level: 'warning', to: '/ops/tenants' },
  ]
}

function OperatorDashboardPage() {
  const days = rangeOf(Route.useSearch())
  const navigate = Route.useNavigate()
  const { data: stats } = useSuspenseQuery(operatorDashboardQuery(days))
  const audit = useQuery(auditLogQuery())
  const recent = audit.data?.items.slice(0, 10)
  const { platform, verification } = stats

  return (
    <div className="space-y-4">
      <PageHeader title="Platform" description="Every tenant on this deployment, and what needs an operator." actions={<RangeTabs value={days} onChange={(next) => navigate({ search: { days: next }, replace: true })} />} />
      <HealthStrip health={stats.health} />

      <StatGrid className="xl:grid-cols-6">
        <StatTile testId="stat-tenants" label="Tenants" value={platform.tenants.ready} sub={`ready of ${platform.tenants.total} · ${platform.tenants.failed} failed`} />
        <StatTile testId="stat-connections" label="Connections" value={platform.connections} sub={`${stats.outcomes.connections.completed ?? 0} completed`} />
        <StatTile testId="stat-credentials" label="Credential exchanges" value={platform.credentials} sub={`${stats.outcomes.credentials.done ?? 0} issued`} />
        <StatTile testId="stat-proofs" label="Proof exchanges" value={platform.proofs} sub={`${stats.outcomes.proofs.done ?? 0} completed`} />
        <StatTile testId="stat-wallets" label="Active wallets" value={platform.wallets.active} sub={`${platform.wallets.revoked} revoked`} />
        <StatTile testId="stat-api-keys" label="Active API keys" value={platform.apiKeys.active} sub={`${platform.apiKeys.revoked} revoked`} />
      </StatGrid>

      {/* Outcomes of the window across tenants (implement/22 C10); each tenant's Verification page has the detail. */}
      <StatGrid className="xl:grid-cols-2">
        <StatTile
          testId="stat-proofs-verified"
          label={`Proof requests verified, last ${stats.days} days`}
          value={percent(verification.proofsVerified, verification.proofsRequested)}
          sub={`${verification.proofsVerified} of ${verification.proofsRequested} · ${verification.proofsFailed} failed verification`}
        />
        <StatTile
          testId="stat-face-checks-passed"
          label={`Face checks passed, last ${stats.days} days`}
          value={percent(verification.faceChecksPassed, verification.faceChecksPassed + verification.faceChecksFailed)}
          sub={`${verification.faceChecksPassed} passed · ${verification.faceChecksFailed} failed or expired · ${verification.faceChecks} started`}
        />
      </StatGrid>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>Exchanges started per day (UTC) across all tenants over the last {stats.days} days.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActivityChart series={stats.series} testId="activity-chart" />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <AttentionList items={attentionItems(stats)} testId="attention-list" />
        <Card size="sm">
          <CardHeader>
            <CardTitle>Busiest tenants</CardTitle>
            <CardDescription>Exchanges started in the window.</CardDescription>
          </CardHeader>
          <CardContent>
            {stats.topTenants.length === 0 ? (
              <p className="text-sm text-muted-foreground">No exchanges in this window.</p>
            ) : (
              <ol className="divide-y" data-testid="top-tenants">
                {stats.topTenants.map((tenant) => (
                  <li key={tenant.tenantId} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <Link to="/ops/tenants/$tenantId" params={{ tenantId: tenant.tenantId }} className="min-w-0 truncate font-medium hover:underline">
                      {tenant.name}
                    </Link>
                    <span className="tabular-nums">{tenant.exchanges}</span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Recent console actions</CardTitle>
          <CardDescription>
            The latest audited calls.{' '}
            <Link to="/ops/audit" className="underline">
              Full audit log
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {audit.error ? (
            <p className="text-sm text-destructive">{audit.error.message}</p>
          ) : !recent ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing audited yet.</p>
          ) : (
            <ul className="divide-y" data-testid="recent-audit">
              {recent.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                  <span className="text-muted-foreground tabular-nums">{formatDateTime(entry.at)}</span>
                  <span className="min-w-0 truncate">{entry.actorEmail ?? entry.actor}</span>
                  <StateBadge state={entry.role} />
                  <span className={auditAction(entry).event ? undefined : 'font-mono text-xs'}>{auditAction(entry).text}</span>
                  <span className="font-mono text-xs text-muted-foreground">{auditResult(entry)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
