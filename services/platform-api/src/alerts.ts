/**
 * Alerts for the operators' system health page (implement/22-console-feedback.md C16).
 *
 * Prometheus and Alertmanager listen on the host's loopback only, and the console lives on a Docker
 * network, so the console cannot ask them anything. Alertmanager pushes instead: its webhook receiver
 * posts every notification to `POST /internal/alerts` (routes/internal.ts), and this module keeps
 * what it said in `platform_alerts`. The health route reads from there.
 *
 *   - One row per occurrence (fingerprint + start). A repeated notification updates its row.
 *   - A `Watchdog` alert that always fires is the heartbeat: the newest `last_received_at` of any
 *     row says when monitoring last reported.
 *   - A firing alert Alertmanager stops repeating without ever resolving it (platform-api was down
 *     when the resolve came) is closed after `ALERT_STALE_MS`.
 *   - Resolved alerts are kept `ALERT_KEEP_MS`, then deleted.
 */
import { and, desc, eq, gte, lt, max, ne, sql } from 'drizzle-orm'
import { z } from 'zod'

import type { Database } from './db/client.ts'
import { platformAlerts } from './db/schema.ts'

/** The always-firing heartbeat rule (infra/compose/monitoring/alerts.yml). Never listed as an alert. */
export const WATCHDOG_ALERT = 'Watchdog'
/** Alertmanager repeats a firing alert to the webhook every hour; three missed repeats close it. */
export const ALERT_STALE_MS = 3 * 60 * 60 * 1000
export const ALERT_KEEP_MS = 30 * 24 * 60 * 60 * 1000
/** The health page lists what was resolved in this window. */
export const ALERT_RECENT_MS = 7 * 24 * 60 * 60 * 1000
/** The Watchdog arrives every five minutes; after this long without anything, monitoring is silent. */
export const MONITORING_SILENT_MS = 15 * 60 * 1000

const instant = z.string().max(64).refine((value) => !Number.isNaN(Date.parse(value)), 'not a timestamp')

/** Alertmanager's webhook payload (version 4), the part that is read. Unknown fields are ignored. */
export const alertmanagerBody = z.looseObject({
  alerts: z
    .array(
      z.looseObject({
        status: z.enum(['firing', 'resolved']),
        labels: z.record(z.string(), z.string()),
        annotations: z.record(z.string(), z.string()).optional(),
        startsAt: instant,
        endsAt: instant.optional(),
        fingerprint: z.string().min(1).max(100),
      })
    )
    .max(500),
})
export type AlertmanagerAlert = z.infer<typeof alertmanagerBody>['alerts'][number]

const clip = (value: string | undefined, length: number) => (value === undefined ? null : value.slice(0, length))

/** Label values are free text from rule files; keep a bounded copy. */
function boundedLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).slice(0, 30).map(([key, value]) => [key.slice(0, 100), value.slice(0, 300)]))
}

/** Stores one notification's alerts. Idempotent: Alertmanager repeats and retries. */
export async function recordAlerts(db: Database, alerts: AlertmanagerAlert[], now = new Date()) {
  for (const alert of alerts) {
    const startsAt = new Date(alert.startsAt)
    const resolved = alert.status === 'resolved'
    // A firing alert carries a zero `endsAt`; only a resolved one says when it ended.
    const endsAt = resolved && alert.endsAt && Date.parse(alert.endsAt) > startsAt.getTime() ? new Date(alert.endsAt) : resolved ? now : null
    const values = {
      name: (alert.labels.alertname ?? 'unnamed').slice(0, 200),
      severity: clip(alert.labels.severity, 50),
      status: alert.status,
      summary: clip(alert.annotations?.summary, 500),
      description: clip(alert.annotations?.description, 2000),
      labels: boundedLabels(alert.labels),
      endsAt,
      lastReceivedAt: now,
    }
    if (resolved) {
      // A resolve ends whatever is firing under this fingerprint, whether or not it names the same
      // start: an alert that stays listed as firing after it ended is worse than a start that is off.
      const ended = await db
        .update(platformAlerts)
        .set({ ...values, endsAt })
        .where(and(eq(platformAlerts.fingerprint, alert.fingerprint), eq(platformAlerts.status, 'firing')))
        .returning({ id: platformAlerts.id })
      if (ended.length > 0) continue
    }
    await db
      .insert(platformAlerts)
      .values({ fingerprint: alert.fingerprint, startsAt, ...values })
      .onConflictDoUpdate({ target: [platformAlerts.fingerprint, platformAlerts.startsAt], set: values })
    // The same alert firing with a new start (Prometheus restarted) replaces the occurrence before it.
    if (!resolved) {
      await db
        .update(platformAlerts)
        .set({ status: 'resolved', endsAt: startsAt })
        .where(and(eq(platformAlerts.fingerprint, alert.fingerprint), eq(platformAlerts.status, 'firing'), ne(platformAlerts.startsAt, startsAt)))
    }
  }
}

/** Closes firing alerts that are no longer repeated and deletes old resolved ones. */
export async function sweepAlerts(db: Database, now = new Date()) {
  await db
    .update(platformAlerts)
    .set({ status: 'resolved', endsAt: sql`${platformAlerts.lastReceivedAt}` })
    .where(and(eq(platformAlerts.status, 'firing'), ne(platformAlerts.name, WATCHDOG_ALERT), lt(platformAlerts.lastReceivedAt, new Date(now.getTime() - ALERT_STALE_MS))))
  await db.delete(platformAlerts).where(and(eq(platformAlerts.status, 'resolved'), lt(platformAlerts.endsAt, new Date(now.getTime() - ALERT_KEEP_MS))))
}

export async function firingAlertCount(db: Database): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(platformAlerts)
    .where(and(eq(platformAlerts.status, 'firing'), ne(platformAlerts.name, WATCHDOG_ALERT)))
  return row?.n ?? 0
}

export const alertView = z.object({
  name: z.string(),
  severity: z.string().nullable(),
  status: z.enum(['firing', 'resolved']),
  summary: z.string().nullable(),
  description: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime().nullable(),
  lastReceivedAt: z.iso.datetime(),
})

const toAlertView = (row: typeof platformAlerts.$inferSelect): z.infer<typeof alertView> => ({
  name: row.name,
  severity: row.severity,
  status: row.status,
  summary: row.summary,
  description: row.description,
  labels: row.labels,
  startsAt: row.startsAt.toISOString(),
  endsAt: row.endsAt?.toISOString() ?? null,
  lastReceivedAt: row.lastReceivedAt.toISOString(),
})

/** What the health page shows: when monitoring last reported, what fires now, what ended lately. */
export async function alertOverview(db: Database, now = new Date()) {
  const listed = ne(platformAlerts.name, WATCHDOG_ALERT)
  const [[signal], firing, resolved] = await Promise.all([
    db.select({ at: max(platformAlerts.lastReceivedAt) }).from(platformAlerts),
    db.select().from(platformAlerts).where(and(eq(platformAlerts.status, 'firing'), listed)).orderBy(desc(platformAlerts.startsAt)).limit(200),
    db
      .select()
      .from(platformAlerts)
      .where(and(eq(platformAlerts.status, 'resolved'), listed, gte(platformAlerts.endsAt, new Date(now.getTime() - ALERT_RECENT_MS))))
      .orderBy(desc(platformAlerts.endsAt))
      .limit(50),
  ])
  const lastSignalAt = signal?.at ?? null
  return {
    lastSignalAt: lastSignalAt?.toISOString() ?? null,
    silent: lastSignalAt === null || now.getTime() - lastSignalAt.getTime() > MONITORING_SILENT_MS,
    firing: firing.map(toAlertView),
    resolved: resolved.map(toAlertView),
  }
}
