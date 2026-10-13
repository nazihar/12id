/**
 * Change requests (implement/22-console-feedback.md C17): what is stored when a change waits for a
 * second person, and the rules for deciding it.
 *
 *   - whoever asked cannot decide;
 *   - whoever decides must hold a role that could have made the change;
 *   - a request waits REQUEST_TTL_MS, then expires; an approved one that waits for its Apply gets the
 *     same time again from the approval;
 *   - one open request per subject (the unique indexes in schema.ts), so the person who decides
 *     always compares against the value in force.
 */
import { type SQL, and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { z } from 'zod'

import type { Database } from '../db/client.ts'
import { CHANGE_REQUEST_STATUSES, OPEN_CHANGE_REQUEST_STATUSES, changeRequests } from '../db/schema.ts'
import { auditChanges } from '../http/audit-changes.ts'
import type { ConsoleRole } from '../http/auth.ts'
import { PlatformError, notFound } from '../http/errors.ts'
import { type ApprovalTypeId, type HeldCall, approvalType } from './types.ts'

export const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type ChangeRequest = typeof changeRequests.$inferSelect

/** Who is asking or deciding. */
export interface Actor {
  id: string
  label?: string
  role: ConsoleRole
}

export const changeRequestView = z.object({
  id: z.string(),
  tenantId: z.string().nullable(),
  type: z.string(),
  /** What kind of change, in words. */
  label: z.string(),
  executor: z.enum(['platform', 'console']),
  /** `by_requester`: once approved, the person who asked presses Apply. */
  apply: z.enum(['on_approval', 'by_requester']),
  /** The console roles that may decide it (never the person who asked, whatever their role). */
  roles: z.array(z.string()),
  summary: z.string(),
  /** The change as it was asked for, with secrets and personal data replaced. */
  change: z.unknown().nullable(),
  /** The value in force when it was asked for. */
  before: z.unknown().nullable(),
  status: z.enum(CHANGE_REQUEST_STATUSES),
  requestedBy: z.string(),
  requestedByLabel: z.string().nullable(),
  requestedByRole: z.string(),
  requestedAt: z.iso.datetime(),
  decidedBy: z.string().nullable(),
  decidedByLabel: z.string().nullable(),
  decidedByRole: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionReason: z.string().nullable(),
  appliedAt: z.iso.datetime().nullable(),
  applyError: z.string().nullable(),
  expiresAt: z.iso.datetime(),
})
export type ChangeRequestView = z.infer<typeof changeRequestView>

/** `202` of a held route: the change was not made; it waits as this request. */
export const heldView = z.object({ approval: changeRequestView })
/** Spread into a held route's `response`, so the console's typed client knows the route can answer this. */
export const held = { 202: heldView } as const

export function toChangeRequestView(row: ChangeRequest): ChangeRequestView {
  // What is shown: a console change's payload, a platform change's stored call, or (a biometric
  // provider, whose configuration is not kept here) the public part that was kept for showing.
  const stored = row.payload ?? row.body
  return {
    id: row.id,
    tenantId: row.tenantId,
    type: row.type,
    label: approvalType(row.type)?.label ?? row.type,
    executor: row.executor,
    apply: row.apply,
    roles: [...(approvalType(row.type)?.roles ?? [])],
    summary: row.summary,
    change: stored === null || stored === undefined ? null : (auditChanges({ body: stored, recordBody: true })?.body ?? null),
    before: row.before ?? null,
    status: row.status,
    requestedBy: row.requestedBy,
    requestedByLabel: row.requestedByLabel,
    requestedByRole: row.requestedByRole,
    requestedAt: row.requestedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedByLabel: row.decidedByLabel,
    decidedByRole: row.decidedByRole,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    applyError: row.applyError,
    expiresAt: row.expiresAt.toISOString(),
  }
}

const isOpen = (status: string) => (OPEN_CHANGE_REQUEST_STATUSES as readonly string[]).includes(status)
const scopeOf = (tenantId: string | null): SQL => (tenantId === null ? isNull(changeRequests.tenantId) : eq(changeRequests.tenantId, tenantId))
const uniqueViolation = (error: unknown) => {
  const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code
  return code === '23505'
}

export function assertRole(typeId: string, role: ConsoleRole, doing: 'ask for' | 'decide') {
  const type = approvalType(typeId)
  if (!type) throw new PlatformError(400, 'bad_request', `unknown kind of change: ${typeId}`)
  if (!type.roles.includes(role)) throw new PlatformError(403, 'forbidden', `your role cannot ${doing} this change`)
  return type
}

export interface NewRequest {
  tenantId: string | null
  typeId: ApprovalTypeId
  call: HeldCall
  actor: Actor
  /** A platform change: the call to make again. `storeBody: false` keeps a body that may carry secrets out. */
  replay?: { method: string; route: string; storeBody?: boolean }
  /** A console change: what the console needs to perform it. */
  payload?: Record<string, unknown>
  before?: unknown
  now?: Date
}

export async function createRequest(db: Database, input: NewRequest): Promise<ChangeRequest> {
  const type = assertRole(input.typeId, input.actor.role, 'ask for')
  const now = input.now ?? new Date()
  const subject = type.subject(input.call)
  // An expired request still holds its subject until something marks it; do that first.
  await expireDue(db, now)
  try {
    const [row] = await db
      .insert(changeRequests)
      .values({
        tenantId: input.tenantId,
        type: input.typeId,
        executor: type.executor,
        apply: type.apply,
        subject,
        summary: type.summary(input.call).slice(0, 500),
        method: input.replay?.method ?? null,
        route: input.replay?.route ?? null,
        body: input.replay && input.replay.storeBody !== false ? (input.call.body ?? null) : null,
        payload: input.payload ?? null,
        before: input.before ?? null,
        requestedBy: input.actor.id,
        requestedByLabel: input.actor.label ?? null,
        requestedByRole: input.actor.role,
        requestedAt: now,
        expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
      })
      .returning()
    return row!
  } catch (error) {
    if (!uniqueViolation(error) || subject === null) throw error
    const [open] = await db
      .select()
      .from(changeRequests)
      .where(and(scopeOf(input.tenantId), eq(changeRequests.subject, subject), inArray(changeRequests.status, [...OPEN_CHANGE_REQUEST_STATUSES])))
    const who = open?.requestedByLabel ?? open?.requestedBy ?? 'someone'
    throw new PlatformError(409, 'approval_pending', `a change to this is already waiting (asked by ${who}); it has to be decided or cancelled first`)
  }
}

/** The request, in the caller's scope only; one whose time is up comes back as expired. */
export async function findRequest(db: Database, tenantId: string | null, id: string, now = new Date()): Promise<ChangeRequest> {
  const [row] = await db.select().from(changeRequests).where(and(scopeOf(tenantId), eq(changeRequests.id, id)))
  if (!row) throw notFound('change request')
  if (isOpen(row.status) && row.expiresAt.getTime() <= now.getTime()) {
    const [expired] = await db.update(changeRequests).set({ status: 'expired' }).where(and(eq(changeRequests.id, id), inArray(changeRequests.status, [...OPEN_CHANGE_REQUEST_STATUSES]))).returning()
    return expired ?? row
  }
  return row
}

const notIn = (row: ChangeRequest, wanted: string) => new PlatformError(409, 'conflict', `this request is ${row.status}, not ${wanted}`)

export async function decide(db: Database, row: ChangeRequest, actor: Actor, decision: 'approved' | 'rejected', reason?: string, now = new Date()): Promise<ChangeRequest> {
  if (row.status !== 'pending') throw notIn(row, 'pending')
  if (actor.id === row.requestedBy) throw new PlatformError(403, 'same_person', 'the person who asked for a change cannot decide it')
  assertRole(row.type, actor.role, 'decide')
  const [updated] = await db
    .update(changeRequests)
    .set({
      status: decision,
      decidedBy: actor.id,
      decidedByLabel: actor.label ?? null,
      decidedByRole: actor.role,
      decidedAt: now,
      decisionReason: decision === 'rejected' ? (reason ?? null) : null,
      // An approved request may wait for its Apply: a fresh period from the approval.
      ...(decision === 'approved' ? { expiresAt: new Date(now.getTime() + REQUEST_TTL_MS) } : {}),
    })
    // Two people deciding at once: only one of them finds it pending.
    .where(and(eq(changeRequests.id, row.id), eq(changeRequests.status, 'pending')))
    .returning()
  if (!updated) throw new PlatformError(409, 'conflict', 'this request was decided a moment ago')
  return updated
}

/** Only the person who asked can withdraw a request, while it is open. */
export async function cancel(db: Database, row: ChangeRequest, actor: Actor): Promise<ChangeRequest> {
  if (!isOpen(row.status)) throw notIn(row, 'open')
  if (actor.id !== row.requestedBy) throw new PlatformError(403, 'forbidden', 'only the person who asked can cancel a request')
  const [updated] = await db.update(changeRequests).set({ status: 'cancelled' }).where(and(eq(changeRequests.id, row.id), inArray(changeRequests.status, [...OPEN_CHANGE_REQUEST_STATUSES]))).returning()
  if (!updated) throw new PlatformError(409, 'conflict', 'this request was closed a moment ago')
  return updated
}

/** The person who asked presses Apply on an approved request. */
export function assertApplicable(row: ChangeRequest, actor: Actor) {
  if (row.status !== 'approved') throw notIn(row, 'approved')
  if (actor.id !== row.requestedBy) throw new PlatformError(403, 'forbidden', 'only the person who asked can apply an approved request')
}

/** The change was made (or could not be made any more): the request is closed. */
export async function finish(db: Database, row: ChangeRequest, outcome: { ok: true } | { ok: false; error: string }, now = new Date()): Promise<ChangeRequest> {
  const [updated] = await db
    .update(changeRequests)
    .set(outcome.ok ? { status: 'applied', appliedAt: now, applyError: null } : { status: 'failed', appliedAt: null, applyError: outcome.error.slice(0, 1000) })
    .where(and(eq(changeRequests.id, row.id), eq(changeRequests.status, 'approved')))
    .returning()
  if (!updated) throw new PlatformError(409, 'conflict', 'this request is no longer waiting to be applied')
  return updated
}

/** Marks open requests whose time is up; returns them, so what they held can be released. */
export async function expireDue(db: Database, now = new Date()): Promise<ChangeRequest[]> {
  return db.update(changeRequests).set({ status: 'expired' }).where(and(inArray(changeRequests.status, [...OPEN_CHANGE_REQUEST_STATUSES]), lt(changeRequests.expiresAt, now))).returning()
}

/** Closed requests older than `before` are deleted with the audit log (implement/22 C15). */
export async function purgeClosed(db: Database, before: Date): Promise<number> {
  const result = await db.delete(changeRequests).where(and(sql`${changeRequests.status} not in ('pending', 'approved')`, lt(changeRequests.requestedAt, before)))
  return result.rowCount ?? 0
}


export { scopeOf as changeRequestScope }
