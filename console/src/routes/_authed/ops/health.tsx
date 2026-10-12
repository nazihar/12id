import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { CircleAlertIcon, CircleCheckIcon, TriangleAlertIcon } from 'lucide-react'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CHECK_LABELS, type HealthLevel, duration, healthSummary, severityLevel } from '@/features/ops/health-format'
import { type SystemHealth, systemHealthQuery } from '@/features/ops/ops.queries'
import { formatDateTime } from '@/lib/format'

// System health for operators and auditors (implement/22-console-feedback.md C16): what platform-api
// can reach right now, what monitoring reported, and what this deployment runs with. Read-only.
// Monitoring pushes its alerts to platform-api; the console never talks to Prometheus or Alertmanager.
export const Route = createFileRoute('/_authed/ops/health')({
  loader: ({ context }) => context.queryClient.ensureQueryData(systemHealthQuery()),
  errorComponent: RouteError,
  component: SystemHealthPage,
})

type AlertRow = SystemHealth['alerts']['firing'][number]

const ICONS = { good: CircleCheckIcon, warning: TriangleAlertIcon, critical: CircleAlertIcon } as const
const COLORS = { good: 'text-status-good', warning: 'text-status-warning', critical: 'text-status-critical' } as const

/** Icon and words together: the level is never carried by colour alone. */
function Level({ level, children }: { level: HealthLevel; children: React.ReactNode }) {
  const Icon = ICONS[level]
  return (
    <span className="flex items-center gap-2">
      <Icon className={`size-4 shrink-0 ${COLORS[level]}`} aria-hidden />
      <span>{children}</span>
    </span>
  )
}

/** Where an alert is about: the labels a rule sets to say which service or host. */
const where = (alert: AlertRow) => alert.labels.instance ?? alert.labels.job ?? alert.labels.name ?? ''

const column = createColumnHelper<DataTableFeatures, AlertRow>()
const what = column.accessor('name', {
  header: 'Alert',
  cell: ({ row }) => (
    <span className="block min-w-0">
      <span className="block font-medium">{row.original.name}</span>
      {row.original.summary && <span className="block text-xs text-muted-foreground">{row.original.summary}</span>}
      {row.original.description && <span className="block max-w-2xl text-xs whitespace-normal text-muted-foreground">{row.original.description}</span>}
    </span>
  ),
})
const on = column.accessor(where, { id: 'where', header: 'On', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span> })

function firingColumns(checkedAt: string) {
  return column.columns([
    column.accessor((row) => row.severity ?? 'warning', {
      id: 'severity',
      header: 'Severity',
      cell: ({ row, getValue }) => <Level level={severityLevel(row.original.severity)}>{getValue()}</Level>,
    }),
    what,
    on,
    column.accessor('startsAt', { header: 'Since', cell: ({ getValue }) => formatDateTime(getValue()) }),
    column.accessor((row) => duration(row.startsAt, checkedAt), { id: 'for', header: 'For' }),
  ])
}

const resolvedColumns = column.columns([
  what,
  on,
  column.accessor('startsAt', { header: 'From', cell: ({ getValue }) => formatDateTime(getValue()) }),
  column.accessor('endsAt', { header: 'Until', cell: ({ getValue }) => formatDateTime(getValue()) }),
  column.accessor((row) => (row.endsAt ? duration(row.startsAt, row.endsAt) : ''), { id: 'lasted', header: 'Lasted' }),
])

function SystemHealthPage() {
  // Re-read every minute while the page is open; the answer is cheap (two small queries and the readiness checks).
  const { data: health } = useSuspenseQuery({ ...systemHealthQuery(), refetchInterval: 60_000 })
  const summary = healthSummary(health)
  const { monitoring } = health
  const checks = Object.entries(health.checks)
  const groups = [...new Set(health.settings.map((setting) => setting.group))]

  return (
    <div className="space-y-6">
      <PageHeader
        title="System health"
        description="What the platform can reach right now, what monitoring reports, and what this deployment runs with. Read-only: alerts are raised and cleared by monitoring, not here."
        meta={<p className="text-xs text-muted-foreground">Checked {formatDateTime(health.checkedAt)}. The page refreshes every minute.</p>}
      />

      <Alert variant={summary.level === 'critical' ? 'destructive' : 'default'} data-testid="health-summary" data-level={summary.level}>
        <AlertDescription>
          <Level level={summary.level}>{summary.text}</Level>
        </AlertDescription>
      </Alert>

      <Card size="sm" data-testid="health-services">
        <CardHeader>
          <CardTitle>Services</CardTitle>
          <CardDescription>Asked by the platform API when this page was loaded. Services it does not call itself (the mediators, the edge, the ledger nodes) are watched by monitoring and show up as alerts.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y text-sm">
            <li className="flex items-center justify-between gap-3 py-2">
              <Level level={health.draining ? 'warning' : 'good'}>Platform API</Level>
              <span className="text-muted-foreground">{health.draining ? 'shutting down for a restart' : 'answering'}</span>
            </li>
            {checks.map(([name, ok]) => (
              <li key={name} className="flex items-center justify-between gap-3 py-2" data-testid={`health-check-${name}`}>
                <Level level={ok ? 'good' : 'critical'}>{CHECK_LABELS[name] ?? name}</Level>
                <span className="text-muted-foreground">{ok ? 'answering' : 'not answering'}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <PageHeader
          level={2}
          title="Alerts firing now"
          badge={health.alerts.firing.length > 0 ? <Badge variant="destructive">{health.alerts.firing.length}</Badge> : undefined}
          description={
            !monitoring.connected
              ? 'This deployment does not accept alerts from monitoring (no alert secret is set), so nothing can be listed. The service checks above still work.'
              : monitoring.lastSignalAt === null
                ? 'Monitoring has not reported yet.'
                : monitoring.silent
                  ? `Monitoring last reported ${formatDateTime(monitoring.lastSignalAt)}, ${duration(monitoring.lastSignalAt, health.checkedAt)} before this page was loaded. It reports every five minutes, so this list may be out of date.`
                  : `Monitoring last reported ${duration(monitoring.lastSignalAt, health.checkedAt)} before this page was loaded.`
          }
        />
        <div data-testid="monitoring-signal" data-silent={monitoring.silent} hidden />
        <DataTable columns={firingColumns(health.checkedAt)} data={health.alerts.firing} emptyMessage={monitoring.connected ? 'No alert is firing.' : 'Monitoring is not connected.'} testId="alerts-firing" />
      </section>

      <section className="space-y-3">
        <PageHeader level={2} title="Resolved in the last 7 days" description="Alerts that fired and ended, newest first." />
        <DataTable columns={resolvedColumns} data={health.alerts.resolved} emptyMessage="Nothing fired and ended in the last 7 days." testId="alerts-resolved" />
      </section>

      <Card size="sm" data-testid="health-settings">
        <CardHeader>
          <CardTitle>What is running</CardTitle>
          <CardDescription>The settings this deployment runs with. They are set on the server and change with a deploy; nothing here is a secret.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-x-8 gap-y-5 md:grid-cols-2">
          {groups.map((group) => (
            <div key={group} className="min-w-0">
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">{group}</h3>
              <dl className="divide-y text-sm">
                {health.settings
                  .filter((setting) => setting.group === group)
                  .map((setting) => (
                    <div key={setting.label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
                      <dt>{setting.label}</dt>
                      <dd className="min-w-0 break-all text-muted-foreground">{setting.value}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
