/**
 * System health for operators and auditors (implement/22-console-feedback.md C16): what platform-api
 * can reach right now, what monitoring reported (`alerts.ts`), and what is running. Read-only.
 *
 * The settings are an allow-list written out here, value by value. Nothing is copied from the
 * configuration wholesale, so a secret cannot reach this route by being added to the configuration.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { alertOverview, alertView } from '../../alerts.ts'
import type { PlatformConfig } from '../../config.ts'
import type { Database } from '../../db/client.ts'
import type { ReadinessReport } from '../app.ts'
import { CONSOLE_ONLY_TAG } from './console.ts'

const settingView = z.object({ group: z.string(), label: z.string(), value: z.string() })
const healthView = z.object({
  checkedAt: z.iso.datetime(),
  version: z.string().nullable(),
  environment: z.string().nullable(),
  ready: z.boolean(),
  draining: z.boolean(),
  /** platform-api's own readiness checks, by name: `database`, `agent`, `mediatorDatabase`, `biometric`. */
  checks: z.record(z.string(), z.boolean()),
  monitoring: z.object({
    /** Whether this deployment accepts Alertmanager's notifications at all (ALERT_WEBHOOK_SECRET is set). */
    connected: z.boolean(),
    lastSignalAt: z.iso.datetime().nullable(),
    /** No notification for longer than the heartbeat allows: the lists below may be out of date. */
    silent: z.boolean(),
  }),
  alerts: z.object({ firing: z.array(alertView), resolved: z.array(alertView) }),
  settings: z.array(settingView),
})

const days = (n: number, zero: string) => (n === 0 ? zero : `${n} day${n === 1 ? '' : 's'}`)
const perMinute = (n: number) => (n === 0 ? 'no limit' : `${n} per minute`)

/** What is running, in words. Only values that are safe to show to every operator and auditor. */
export function runningSettings(config: PlatformConfig): Array<z.infer<typeof settingView>> {
  const row = (group: string, label: string, value: string) => ({ group, label, value })
  return [
    row('Deployment', 'Version', config.PLATFORM_VERSION ?? 'not set'),
    row('Deployment', 'Environment', config.PLATFORM_ENVIRONMENT ?? 'not set'),
    row('Deployment', 'Public API address', config.PUBLIC_URL),
    row('Ledger', 'Network', config.INDY_NAMESPACE),
    row('Ledger', 'Genesis file', config.GENESIS_URL),
    row('Data protection', 'Personal data of finished exchanges', days(config.RETENTION_DAYS, 'kept until erased on request')),
    row('Data protection', 'Audit log', days(config.AUDIT_RETENTION_DAYS, 'kept, never deleted')),
    row('Limits', 'Requests per API key', perMinute(config.RATE_LIMIT_API_KEY_PER_MIN)),
    row('Limits', 'Requests per wallet', perMinute(config.RATE_LIMIT_WALLET_PER_MIN)),
    row('Limits', 'Mediator invitations per wallet', config.RATE_LIMIT_INVITATION_PER_10MIN === 0 ? 'no limit' : `${config.RATE_LIMIT_INVITATION_PER_10MIN} per 10 minutes`),
    row('Webhooks', 'Delivery attempts before a delivery is dead', String(config.WEBHOOK_MAX_ATTEMPTS)),
    row('Webhooks', 'Time a receiver has to answer', `${Math.round(config.WEBHOOK_TIMEOUT_MS / 1000)} s`),
    row('Wallets', 'A wallet that never connected is revoked after', days(config.WALLET_UNCONNECTED_REVOKE_DAYS, 'never')),
    row('Wallets', "A revoked wallet's mediator records are removed after", days(config.WALLET_REVOKED_GRACE_DAYS, 'at once')),
    row('Accounts', 'Changes to operator accounts need a second operator', config.OPERATOR_APPROVALS === 'on' ? 'yes' : 'no'),
    row('Connected services', 'Console', config.CONSOLE_TOKEN ? 'enabled' : 'disabled'),
    row('Connected services', 'Biometric service', config.BIOMETRIC_SERVICE_URL && config.BIOMETRIC_SERVICE_TOKEN ? 'connected' : 'not configured'),
    row('Connected services', 'Monitoring alerts', config.ALERT_WEBHOOK_SECRET ? 'accepted' : 'not configured'),
    row('Connected services', 'Housekeeping (wallet sweep, retention)', config.SWEEP_INTERVAL_MS === 0 ? 'off' : `every ${Math.round(config.SWEEP_INTERVAL_MS / 60_000)} minutes`),
  ]
}

export const healthRoutes = (deps: { db: Database; config: PlatformConfig; readiness: () => Promise<ReadinessReport> }): FastifyPluginAsyncZod => async (app) => {
  app.get(
    '/admin/health',
    {
      schema: {
        tags: ['admin', CONSOLE_ONLY_TAG],
        summary: 'System health',
        description: 'The readiness checks, the alerts monitoring reported (firing now, and resolved in the last 7 days), when monitoring last reported, and the non-secret settings this deployment runs with.',
        response: { 200: healthView },
      },
    },
    async () => {
      const now = new Date()
      const [report, alerts] = await Promise.all([deps.readiness().catch(() => ({ ready: false, draining: false, checks: {} })), alertOverview(deps.db, now)])
      const connected = Boolean(deps.config.ALERT_WEBHOOK_SECRET)
      return {
        checkedAt: now.toISOString(),
        version: deps.config.PLATFORM_VERSION ?? null,
        environment: deps.config.PLATFORM_ENVIRONMENT ?? null,
        ready: report.ready,
        draining: report.draining,
        checks: report.checks,
        monitoring: { connected, lastSignalAt: alerts.lastSignalAt, silent: !connected || alerts.silent },
        alerts: { firing: alerts.firing, resolved: alerts.resolved },
        settings: runningSettings(deps.config),
      }
    }
  )
}
