/**
 * Approval by a second person (implement/22-console-feedback.md C19). Two sets of the same functions:
 *
 *   portal  a member of an organization, for that organization's requests;
 *   ops     an operator, for one tenant's requests (`tenantId`) or, without one, for the requests of
 *           the operator area itself (changes to operator accounts).
 *
 * platform-api holds the requests and the rules (who may decide, never the person who asked). The
 * console adds what only it knows: how many people could approve, before the requirement is switched
 * on, and how to perform an account change once its request is approved.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { z } from 'zod'

import { assertSameOrganization, organizationInput } from '@/features/portal/organization-input'
import { pageParams } from '@/lib/list-search'
import { OPERATOR_ROLE, tenantRoles } from '@/lib/permissions'
import { applyApproved } from '@/server/account-changes.server'
import { CLOSED, WAITING, approvalsFor } from '@/server/approvals.server'
import { consoleDb } from '@/server/db.server'
import { member, organization, user } from '@/server/db/auth-schema'
import { type Principal, operatorMiddleware, operatorReadMiddleware, tenantMiddleware } from '@/server/middleware'
import { platformFor, unwrapHeld } from '@/server/platform.server'

import { type ApprovalSearch, approvalSearch, decisionInput, requestInput } from './approvals.schemas'

/** Approving needs someone other than the asker, so the requirement makes sense from two people up. */
const MIN_APPROVERS = 2

/** How many members of the organization hold a role that can decide a change (owner or admin). */
async function organizationApprovers(where: { organizationId: string } | { tenantId: string }): Promise<number> {
  const { db } = consoleDb()
  const rows =
    'organizationId' in where
      ? await db.select({ role: member.role }).from(member).where(eq(member.organizationId, where.organizationId))
      : await db.select({ role: member.role }).from(member).innerJoin(organization, eq(organization.id, member.organizationId)).where(eq(organization.platformTenantId, where.tenantId))
  const decides = (role: string) => role.split(',').some((r) => tenantRoles[r.trim() as keyof typeof tenantRoles]?.authorize({ approval: ['decide'] }).success)
  return rows.filter((row) => decides(row.role)).length
}

/** Operators who can sign in: the people who can decide a change to an operator account. */
async function activeOperators(): Promise<number> {
  const rows = await consoleDb()
    .db.select({ id: user.id })
    .from(user)
    .where(and(inArray(user.role, [OPERATOR_ROLE]), or(isNull(user.banned), eq(user.banned, false))))
  return rows.length
}

async function overview(principal: Principal, tenantId: string | null, approvers: number) {
  const setting = await approvalsFor(principal, tenantId).setting()
  return { required: setting.required, types: setting.types, approvers, enough: approvers >= MIN_APPROVERS }
}

function listOf(principal: Principal, tenantId: string | null, search: ApprovalSearch) {
  const { page, pageSize } = pageParams(search)
  return approvalsFor(principal, tenantId).list({ status: (search.tab ?? 'waiting') === 'waiting' ? WAITING : CLOSED, page, pageSize })
}

/** What waits right now, for the sidebar's count and the notices on the pages it is about. */
async function openOf(principal: Principal, tenantId: string | null) {
  const page = await approvalsFor(principal, tenantId).list({ status: WAITING, page: 1, pageSize: 100 })
  return {
    total: page.total,
    items: page.items.map((item) => ({ id: item.id, type: item.type, summary: item.summary, status: item.status, apply: item.apply, requestedByLabel: item.requestedByLabel, mine: item.mine })),
  }
}

async function decide(principal: Principal, tenantId: string | null, input: z.infer<typeof decisionInput>) {
  const approvals = approvalsFor(principal, tenantId)
  if (input.action === 'approve') return approvals.approve(input.id)
  if (!input.reason) throw new Error('Say why you reject it: the person who asked will read it.')
  return approvals.reject(input.id, input.reason)
}

async function setRequired(principal: Principal, tenantId: string, required: boolean, approvers: number) {
  if (required && approvers < MIN_APPROVERS) {
    throw new Error(`This organization has ${approvers === 1 ? 'one person' : 'nobody'} who could approve a change (an owner or admin). Add a second one first: with the requirement on, nobody can approve their own request.`)
  }
  return unwrapHeld(await platformFor(principal, { tenantId }).PUT('/v1/approvals', { body: { required } }))
}

// --- portal -----------------------------------------------------------------------------------

export const getPortalApprovals = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => overview(context.principal, context.principal.tenantId, await organizationApprovers({ organizationId: context.organization.id })))

export const listPortalChangeRequests = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(approvalSearch)
  .handler(async ({ context, data }) => listOf(context.principal, context.principal.tenantId, data))

export const listPortalOpenChanges = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => openOf(context.principal, context.principal.tenantId))

export const setPortalApprovals = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ approval: ['configure'] })])
  .validator(organizationInput.extend({ required: z.boolean() }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return setRequired(context.principal, context.principal.tenantId as string, data.required, await organizationApprovers({ organizationId: context.organization.id }))
  })

export const decidePortalChange = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ approval: ['decide'] })])
  .validator(organizationInput.extend(decisionInput.shape))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return decide(context.principal, context.principal.tenantId, data)
  })

/** Only the person who asked; platform-api checks that. */
export const cancelPortalChange = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware()])
  .validator(organizationInput.extend(requestInput.shape))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return approvalsFor(context.principal, context.principal.tenantId).cancel(data.id)
  })

/** Only the person who asked; platform-api checks that. A secret in the answer is shown once. */
export const applyPortalChange = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware()])
  .validator(organizationInput.extend(requestInput.shape))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return applyApproved(context.principal, context.principal.tenantId, data.id, context.organization.id)
  })

// --- operators: one tenant's requests, or the operator area's own --------------------------------

/** `tenantId` absent: the operator area (changes to operator accounts). */
const scopeInput = z.object({ tenantId: z.uuid().optional() })

export const getOpsApprovals = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(scopeInput)
  .handler(async ({ context, data }) => overview(context.principal, data.tenantId ?? null, data.tenantId ? await organizationApprovers({ tenantId: data.tenantId }) : await activeOperators()))

export const listOpsChangeRequests = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(scopeInput.extend(approvalSearch.shape))
  .handler(async ({ context, data }) => listOf(context.principal, data.tenantId ?? null, data))

export const listOpsOpenChanges = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(scopeInput)
  .handler(async ({ context, data }) => openOf(context.principal, data.tenantId ?? null))

export const setTenantApprovals = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(z.object({ tenantId: z.uuid(), required: z.boolean() }))
  .handler(async ({ context, data }) => setRequired(context.principal, data.tenantId, data.required, await organizationApprovers({ tenantId: data.tenantId })))

export const decideOpsChange = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(scopeInput.extend(decisionInput.shape))
  .handler(async ({ context, data }) => decide(context.principal, data.tenantId ?? null, data))

export const cancelOpsChange = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(scopeInput.extend(requestInput.shape))
  .handler(async ({ context, data }) => approvalsFor(context.principal, data.tenantId ?? null).cancel(data.id))

export const applyOpsChange = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(scopeInput.extend(requestInput.shape))
  .handler(async ({ context, data }) => applyApproved(context.principal, data.tenantId ?? null, data.id))
