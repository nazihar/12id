/**
 * The tenant dashboard body (Phase 4 C8): KPI row, activity and outcome charts, attention list and
 * webhook card for one tenant's `/v1/stats`. Rendered by the portal Overview and by the operator's
 * tenant detail — one set of components, two callers, as `tenant-data/panels.tsx` already does. The
 * caller passes where its own pages live, since the two areas have different routes.
 */
import type { LinkProps } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'

import { type AttentionItem, AttentionList } from '@/components/dashboard/attention-list'
import { ActivityChart, OutcomeBar, outcomeRow } from '@/components/dashboard/charts'
import { StatGrid, StatTile } from '@/components/dashboard/stat-tile'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime } from '@/lib/format'

import type { TenantDashboard } from './dashboard.queries'

export interface TenantDashboardLinks {
  exchanges: Pick<LinkProps, 'to' | 'params'>
  wallets: Pick<LinkProps, 'to' | 'params'>
  webhooks: Pick<LinkProps, 'to' | 'params'>
}

/** platform-api's exchange states grouped for the outcome bar. Connections complete; the other two finish in `done`. */
export const CONNECTION_OUTCOMES = { done: ['completed'], abandoned: ['abandoned'] }
export const EXCHANGE_OUTCOMES = { done: ['done'], abandoned: ['abandoned', 'declined'] }

export function tenantAttentionItems(stats: TenantDashboard, links: TenantDashboardLinks): AttentionItem[] {
  const a = stats.attention
  return [
    { key: 'dead-deliveries', label: 'Dead webhook deliveries', detail: 'Gave up after every retry; retry them once the endpoint is fixed.', count: a.deadDeliveries, level: 'critical', ...links.webhooks },
    { key: 'stuck-credentials', label: 'Credential exchanges stuck for over a day', detail: 'The holder never answered; re-offer on a new exchange.', count: a.stuckCredentials, level: 'warning', ...links.exchanges },
    { key: 'stuck-proofs', label: 'Proof exchanges stuck for over a day', detail: 'No presentation arrived; request again.', count: a.stuckProofs, level: 'warning', ...links.exchanges },
    { key: 'expiring-credentials', label: 'Credentials expiring within 30 days', detail: 'Credentials cannot be revoked; re-issue before their expiresOn date passes.', count: a.expiringCredentials, level: 'warning', ...links.exchanges },
    { key: 'expired-credentials', label: 'Credentials already expired', detail: 'Verifiers refuse them; re-issue if the holder still needs one.', count: a.expiredCredentials, level: 'warning', ...links.exchanges },
    { key: 'wallets-never-connected', label: 'Wallets that never reached the mediator', detail: 'Created over a day ago with no mediator connection; usually a token that never reached the app.', count: a.walletsNeverConnected, level: 'warning', ...links.wallets },
  ]
}

export function TenantDashboardBody({ stats, links }: { stats: TenantDashboard; links: TenantDashboardLinks }) {
  const { totals, webhook } = stats
  const inFlight = (byState: Record<string, number>, outcomes: { done: string[]; abandoned: string[] }) => outcomeRow('', byState, outcomes).inFlight
  const outcomes = [outcomeRow('Connections', totals.connections.byState, CONNECTION_OUTCOMES), outcomeRow('Credentials', totals.credentials.byState, EXCHANGE_OUTCOMES), outcomeRow('Proofs', totals.proofs.byState, EXCHANGE_OUTCOMES)]

  return (
    <div className="space-y-4">
      <StatGrid>
        <StatTile testId="stat-connections" label="Connections" value={totals.connections.byState.completed ?? 0} sub={`${inFlight(totals.connections.byState, CONNECTION_OUTCOMES)} in progress · ${totals.connections.total} total`} />
        <StatTile testId="stat-credentials" label="Credentials issued" value={totals.credentials.byState.done ?? 0} sub={`${inFlight(totals.credentials.byState, EXCHANGE_OUTCOMES)} in flight · ${totals.credentials.total} exchanges`} />
        <StatTile testId="stat-proofs" label="Proofs verified" value={totals.proofs.verified} sub={`${totals.proofs.failed} failed · ${inFlight(totals.proofs.byState, EXCHANGE_OUTCOMES)} in flight`} />
        <StatTile testId="stat-wallets" label="Active wallets" value={totals.wallets.active} sub={`${totals.wallets.revoked} revoked · ${totals.apiKeys.active} active API keys`} />
      </StatGrid>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Activity</CardTitle>
            <CardDescription>Exchanges started per day (UTC) over the last {stats.days} days.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActivityChart series={stats.series} testId="activity-chart" />
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>Outcomes</CardTitle>
            <CardDescription>Where every exchange stands today.</CardDescription>
          </CardHeader>
          <CardContent>
            <OutcomeBar rows={outcomes} testId="outcome-chart" />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <AttentionList items={tenantAttentionItems(stats, links)} testId="attention-list" />
        <Card size="sm">
          <CardHeader>
            <CardTitle>Webhook</CardTitle>
            <CardDescription>
              {webhook.configured ? (
                <span className="font-mono text-xs break-all">{webhook.url}</span>
              ) : (
                <>
                  No endpoint configured; events are not delivered.{' '}
                  <Link {...links.webhooks} className="underline">
                    Set one up
                  </Link>
                  .
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Delivered</dt>
              <dd className="tabular-nums">{webhook.deliveries.delivered}</dd>
              <dt className="text-muted-foreground">Pending</dt>
              <dd className="tabular-nums">{webhook.deliveries.pending + webhook.deliveries.sending}</dd>
              <dt className="text-muted-foreground">Dead</dt>
              <dd className="tabular-nums">{webhook.deliveries.dead}</dd>
              <dt className="text-muted-foreground">Last delivered</dt>
              <dd>{formatDateTime(webhook.lastDeliveredAt)}</dd>
              <dt className="text-muted-foreground">Last failure</dt>
              <dd>{formatDateTime(webhook.lastFailureAt)}</dd>
            </dl>
            {webhook.configured && (
              <p className="mt-3 text-sm">
                <Link {...links.webhooks} className="underline">
                  Delivery log
                </Link>
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
