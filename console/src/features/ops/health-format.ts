/**
 * Wording for the System health page (implement/22-console-feedback.md C16). Client-safe and
 * deterministic: every duration is measured between two timestamps of the same response, never
 * against the browser's clock, so the server render and the browser agree.
 */

/** "under a minute", "42 min", "3 h 5 min", "2 d 4 h": how long from `from` to `to`. */
export function duration(from: string, to: string): string {
  const minutes = Math.max(0, Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 60_000))
  if (!Number.isFinite(minutes)) return '—'
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`
}

export const CHECK_LABELS: Record<string, string> = { database: 'Platform database', agent: 'Agent service', mediatorDatabase: 'Mediator database', biometric: 'Biometric service' }

export type HealthLevel = 'good' | 'warning' | 'critical'

/** Alertmanager severities as the rules use them (`infra/compose/monitoring/alerts.yml`); anything else reads as a warning. */
export const severityLevel = (severity: string | null): HealthLevel => (severity === 'critical' ? 'critical' : 'warning')

export interface HealthSummaryInput {
  ready: boolean
  draining: boolean
  checks: Record<string, boolean>
  monitoring: { connected: boolean; silent: boolean }
  alerts: { firing: Array<{ severity: string | null }> }
}

/** The one line at the top of the page: the worst thing first. */
export function healthSummary(health: HealthSummaryInput): { level: HealthLevel; text: string } {
  const failing = Object.entries(health.checks).filter(([, ok]) => !ok).map(([name]) => CHECK_LABELS[name] ?? name)
  const firing = health.alerts.firing.length
  const critical = health.alerts.firing.filter((alert) => alert.severity === 'critical').length
  if (failing.length > 0) return { level: 'critical', text: `${failing.join(', ')} ${failing.length === 1 ? 'is' : 'are'} not answering.` }
  if (critical > 0) return { level: 'critical', text: `${firing} alert${firing === 1 ? '' : 's'} firing, ${critical} of them critical.` }
  if (firing > 0) return { level: 'warning', text: `${firing} alert${firing === 1 ? '' : 's'} firing.` }
  if (health.draining) return { level: 'warning', text: 'The platform API is shutting down for a restart.' }
  if (!health.monitoring.connected) return { level: 'warning', text: 'The services answer. Monitoring is not connected, so alerts are not shown here.' }
  if (health.monitoring.silent) return { level: 'warning', text: 'The services answer. Monitoring has stopped reporting, so the alerts below may be out of date.' }
  return { level: 'good', text: 'Everything answers and no alert is firing.' }
}
