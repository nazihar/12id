/**
 * Which changes need a second person (implement/22-console-feedback.md C17), and how each is
 * described to the person who decides.
 *
 * The rule: a change is held when it opens access, sends data somewhere else, weakens a check, or
 * cannot be undone. A change that only closes access (revoke, remove, ban) is never held: an
 * emergency stop must not wait for a colleague. Erasure is not held either: the customer's backend
 * can erase with its API key, so holding the console's button would protect nothing.
 *
 * Two executors:
 *   platform  a call to this API. It is stored as it was made and made again when it is applied
 *             (`gate.ts`), so the route's own validation and checks run a second time.
 *   console   a Better Auth action (members, operators). The console stores what it needs, performs
 *             the action itself once the request is approved, and reports back.
 *
 * `apply`:
 *   on_approval   takes effect when it is approved.
 *   by_requester  waits for the person who asked to press Apply: the result is a secret shown once
 *                 to that person (a new API key, a webhook's signing secret), or the action runs under
 *                 that person's own session (every console action).
 */
import { eq, and } from 'drizzle-orm'

import type { Database } from '../db/client.ts'
import { biometricSettings, credentialDefinitionPolicies, proofTemplates, tenants, webhookEndpoints } from '../db/schema.ts'
import type { ConsoleRole } from '../http/auth.ts'

/** What was held: the route parameters and the validated body of the call. */
export interface HeldCall {
  params: Record<string, string>
  body: unknown
}

export interface ApprovalType {
  /** What the change is, for a list: "Create an API key". */
  label: string
  executor: 'platform' | 'console'
  apply: 'on_approval' | 'by_requester'
  /** Who may ask, and who may decide (never the person who asked). */
  roles: readonly ConsoleRole[]
  /**
   * What the change is about. Only one request per subject can be open at a time, so the approver
   * always judges against the value that is in force. null: something new each time (a key, a
   * template, a catalogue entry), any number may wait.
   */
  subject: (call: HeldCall) => string | null
  /** One line for the person who decides. */
  summary: (call: HeldCall) => string
  /** The value in force when the request was made, shown next to the new one. */
  before?: (db: Database, tenantId: string, call: HeldCall) => Promise<unknown>
  /** Some calls of a held route change nothing that needs a second person. Default: every call is held. */
  holds?: (call: HeldCall) => boolean
  /**
   * The route stores the request itself, because the body must not be kept here (it may carry vendor
   * secrets). The gate only tells it that the call is held (`request.approvalHold`).
   */
  custom?: true
}

const CONFIG = ['owner', 'admin'] as const
/** What an operator may also do for a tenant in the console: its API keys and its two periods. */
const CONFIG_AND_OPERATOR = ['owner', 'admin', 'operator'] as const
const body = <T>(call: HeldCall) => (call.body ?? {}) as T
const days = (n: number | null | undefined, zero: string) => (n === null || n === undefined ? 'the platform default' : n === 0 ? zero : `${n} days`)

async function templateBefore(db: Database, tenantId: string, call: HeldCall) {
  const [row] = await db.select({ name: proofTemplates.name, definition: proofTemplates.definition, biometricPolicy: proofTemplates.biometricPolicy }).from(proofTemplates).where(and(eq(proofTemplates.tenantId, tenantId), eq(proofTemplates.id, call.params.id ?? '')))
  return row ?? null
}

async function webhookBefore(db: Database, tenantId: string) {
  const [row] = await db.select({ url: webhookEndpoints.url, events: webhookEndpoints.events }).from(webhookEndpoints).where(eq(webhookEndpoints.tenantId, tenantId))
  return row ?? null
}

export const APPROVAL_TYPES = {
  // --- API keys --------------------------------------------------------------------------------
  'api_key.create': {
    label: 'Create an API key',
    executor: 'platform',
    apply: 'by_requester',
    roles: CONFIG_AND_OPERATOR,
    subject: () => null,
    summary: (call) => `New API key "${body<{ label: string }>(call).label}"`,
  },

  // --- webhook ---------------------------------------------------------------------------------
  'webhook.set': {
    label: 'Set the webhook endpoint',
    executor: 'platform',
    // A new endpoint answers with its signing secret, once.
    apply: 'by_requester',
    roles: CONFIG,
    subject: () => 'webhook.endpoint',
    summary: (call) => `Send events to ${body<{ url: string }>(call).url}`,
    before: (db, tenantId) => webhookBefore(db, tenantId),
  },
  'webhook.rotate_secret': {
    label: 'Rotate the webhook signing secret',
    executor: 'platform',
    apply: 'by_requester',
    roles: CONFIG,
    subject: () => 'webhook.secret',
    summary: () => 'New signing secret for the webhook endpoint',
  },
  'webhook.remove': {
    label: 'Remove the webhook endpoint',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG,
    subject: () => 'webhook.endpoint',
    summary: () => 'Stop sending events: remove the webhook endpoint',
    before: (db, tenantId) => webhookBefore(db, tenantId),
  },

  // --- face checks -----------------------------------------------------------------------------
  'biometrics.provider.set': {
    label: 'Set the biometric provider',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG,
    subject: () => 'biometrics.provider',
    summary: (call) => `Use the biometric provider "${body<{ providerId: string }>(call).providerId}"`,
    custom: true,
  },
  'biometrics.provider.remove': {
    label: 'Remove the biometric provider',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG,
    subject: () => 'biometrics.provider',
    summary: () => 'Remove the biometric provider and switch face checks off',
  },
  'biometrics.settings': {
    label: 'Change the face-check switch or default policy',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG,
    subject: () => 'biometrics.settings',
    summary: (call) => `Face checks ${body<{ enabled: boolean }>(call).enabled ? 'on' : 'off'}, with a new default policy`,
    before: async (db, tenantId) => {
      const [row] = await db.select({ enabled: biometricSettings.enabled, defaultPolicy: biometricSettings.defaultPolicy }).from(biometricSettings).where(eq(biometricSettings.tenantId, tenantId))
      return row ?? null
    },
  },
  'biometrics.cred_def_policy': {
    label: 'Change the face-check policy of a credential definition',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG,
    subject: (call) => `credential_definition:${call.params.id}`,
    summary: (call) => `Face-check policy "${body<{ mode: string }>(call).mode}" for credential definition ${call.params.id}`,
    before: async (db, tenantId, call) => {
      // The route also takes the catalogue id; the stored policy is found only by the definition's own id.
      const [row] = await db.select({ biometricPolicy: credentialDefinitionPolicies.biometricPolicy }).from(credentialDefinitionPolicies).where(and(eq(credentialDefinitionPolicies.tenantId, tenantId), eq(credentialDefinitionPolicies.credentialDefinitionId, call.params.id ?? '')))
      return row?.biometricPolicy ?? null
    },
  },

  // --- proof templates -------------------------------------------------------------------------
  'template.create': {
    label: 'Create a proof template',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG,
    subject: () => null,
    summary: (call) => `New proof template "${body<{ name: string }>(call).name}"`,
  },
  'template.update': {
    label: 'Change a proof template',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG,
    subject: (call) => `template:${call.params.id}`,
    summary: (call) => `Change proof template "${body<{ name: string }>(call).name}"`,
    before: templateBefore,
  },
  'template.policy': {
    label: 'Change the face-check policy of a proof template',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG,
    subject: (call) => `template:${call.params.id}`,
    summary: (call) => `Face-check policy "${body<{ mode: string }>(call).mode}" for a proof template`,
    before: async (db, tenantId, call) => {
      const row = await templateBefore(db, tenantId, call)
      return row ? { name: row.name, biometricPolicy: row.biometricPolicy } : null
    },
  },
  'template.delete': {
    label: 'Delete a proof template',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG,
    subject: (call) => `template:${call.params.id}`,
    summary: () => 'Delete a proof template',
    before: async (db, tenantId, call) => {
      const row = await templateBefore(db, tenantId, call)
      return row ? { name: row.name } : null
    },
  },

  // --- catalogue: permanent on the ledger --------------------------------------------------------
  'catalogue.schema': {
    label: 'Publish a schema',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG,
    subject: () => null,
    summary: (call) => {
      const schema = body<{ name: string; version: string }>(call)
      return `Publish schema "${schema.name}" ${schema.version} on the ledger (permanent)`
    },
  },
  'catalogue.cred_def': {
    label: 'Publish a credential definition',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG,
    subject: () => null,
    summary: (call) => `Publish a credential definition (tag "${body<{ tag?: string }>(call).tag ?? 'default'}") on the ledger (permanent)`,
  },

  // --- data protection -------------------------------------------------------------------------
  'retention.data': {
    label: 'Change the retention period',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG_AND_OPERATOR,
    subject: () => 'retention.data',
    summary: (call) => `Keep personal data of finished exchanges for ${days(body<{ retentionDays: number | null }>(call).retentionDays, 'ever (until erased on request)')}`,
    before: async (db, tenantId) => {
      const [row] = await db.select({ retentionDays: tenants.retentionDays }).from(tenants).where(eq(tenants.id, tenantId))
      return { retentionDays: row?.retentionDays ?? null }
    },
  },
  'retention.audit': {
    label: 'Change the audit log period',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG_AND_OPERATOR,
    subject: () => 'retention.audit',
    summary: (call) => `Keep audit log entries for ${days(body<{ auditRetentionDays: number | null }>(call).auditRetentionDays, 'ever')}`,
    before: async (db, tenantId) => {
      const [row] = await db.select({ auditRetentionDays: tenants.auditRetentionDays }).from(tenants).where(eq(tenants.id, tenantId))
      return { auditRetentionDays: row?.auditRetentionDays ?? null }
    },
  },

  // --- the switch itself -------------------------------------------------------------------------
  'approvals.disable': {
    label: 'Stop requiring a second person',
    executor: 'platform',
    apply: 'on_approval',
    roles: CONFIG_AND_OPERATOR,
    subject: () => 'approvals',
    summary: () => 'Stop requiring a second person for sensitive changes',
    // Switching on is never held: it only tightens.
    holds: (call) => body<{ required: boolean }>(call).required === false,
  },

  // --- console actions: members of an organisation -------------------------------------------------
  'member.invite': {
    label: 'Invite a member',
    executor: 'console',
    apply: 'by_requester',
    roles: CONFIG_AND_OPERATOR,
    subject: (call) => `member:${String(body<{ email: string }>(call).email).toLowerCase()}`,
    summary: (call) => {
      const invite = body<{ email: string; role: string }>(call)
      return `Invite ${invite.email} as ${invite.role}`
    },
  },
  'member.role': {
    label: "Change a member's role",
    executor: 'console',
    apply: 'by_requester',
    roles: CONFIG_AND_OPERATOR,
    subject: (call) => `member:${body<{ memberId: string }>(call).memberId}`,
    summary: (call) => {
      const change = body<{ account?: string; role: string }>(call)
      return `Make ${change.account ?? 'a member'} ${change.role}`
    },
  },

  // --- console actions: operator accounts (no tenant) ----------------------------------------------
  'operator.invite': {
    label: 'Add an operator account',
    executor: 'console',
    apply: 'by_requester',
    roles: ['operator'],
    subject: (call) => `operator:${String(body<{ email: string }>(call).email).toLowerCase()}`,
    summary: (call) => {
      const invite = body<{ email: string; role: string }>(call)
      return `Add ${invite.email} as ${invite.role}`
    },
  },
  'operator.role': {
    label: "Change an operator account's role",
    executor: 'console',
    apply: 'by_requester',
    roles: ['operator'],
    subject: (call) => `operator:${body<{ userId: string }>(call).userId}`,
    summary: (call) => {
      const change = body<{ account?: string; role: string }>(call)
      return `Make ${change.account ?? 'an account'} ${change.role}`
    },
  },
  'operator.unban': {
    label: 'Unban an operator account',
    executor: 'console',
    apply: 'by_requester',
    roles: ['operator'],
    subject: (call) => `operator:${body<{ userId: string }>(call).userId}`,
    summary: (call) => `Unban ${body<{ account?: string }>(call).account ?? 'an account'}`,
  },
} as const satisfies Record<string, ApprovalType>

export type ApprovalTypeId = keyof typeof APPROVAL_TYPES
export const APPROVAL_TYPE_IDS = Object.keys(APPROVAL_TYPES) as [ApprovalTypeId, ...ApprovalTypeId[]]
export const approvalType = (id: string): ApprovalType | undefined => (APPROVAL_TYPES as Record<string, ApprovalType>)[id]

/** The types the console performs itself; `tenant` says whether one belongs to an organisation. */
export const CONSOLE_TYPES = { 'member.invite': true, 'member.role': true, 'operator.invite': false, 'operator.role': false, 'operator.unban': false } as const satisfies Partial<Record<ApprovalTypeId, boolean>>
export type ConsoleTypeId = keyof typeof CONSOLE_TYPES
export const TENANT_CONSOLE_TYPE_IDS = (Object.keys(CONSOLE_TYPES) as ConsoleTypeId[]).filter((id) => CONSOLE_TYPES[id]) as [ConsoleTypeId, ...ConsoleTypeId[]]
export const OPERATOR_CONSOLE_TYPE_IDS = (Object.keys(CONSOLE_TYPES) as ConsoleTypeId[]).filter((id) => !CONSOLE_TYPES[id]) as [ConsoleTypeId, ...ConsoleTypeId[]]
