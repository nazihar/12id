/**
 * Customer-facing shapes of the mirror rows. Shared by the REST routes (response schemas) and
 * the webhook payloads, so a customer sees one representation everywhere.
 */
import { z } from 'zod'

import type { connections, credentials, proofs, wallets } from './db/schema.ts'

export const connectionView = z.object({
  id: z.string(),
  state: z.string(),
  invitationId: z.string().nullable(),
  theirLabel: z.string().nullable(),
  externalId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type ConnectionView = z.infer<typeof connectionView>

export const credentialView = z.object({
  id: z.string(),
  state: z.string(),
  connectionId: z.string().nullable(),
  threadId: z.string().nullable(),
  externalId: z.string().nullable(),
  credentialDefinitionId: z.string().nullable(),
  attributes: z.record(z.string(), z.string()).nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type CredentialView = z.infer<typeof credentialView>

export const proofView = z.object({
  id: z.string(),
  state: z.string(),
  connectionId: z.string().nullable(),
  threadId: z.string().nullable(),
  externalId: z.string().nullable(),
  templateId: z.string().nullable(),
  verified: z.boolean().nullable(),
  disclosed: z.record(z.string(), z.record(z.string(), z.string())).nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type ProofView = z.infer<typeof proofView>

export const walletView = z.object({
  id: z.string(),
  externalId: z.string().nullable(),
  hasMediatorInvitation: z.boolean(),
  lastSyncRequestedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
})

const iso = (d: Date) => d.toISOString()

export function toConnectionView(row: typeof connections.$inferSelect): ConnectionView {
  return { id: row.recordId, state: row.state, invitationId: row.invitationId, theirLabel: row.theirLabel, externalId: row.externalId, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }
}

export function toCredentialView(row: typeof credentials.$inferSelect): CredentialView {
  return {
    id: row.recordId,
    state: row.state,
    connectionId: row.connectionId,
    threadId: row.threadId,
    externalId: row.externalId,
    credentialDefinitionId: row.credentialDefinitionId,
    attributes: row.attributes,
    errorMessage: row.errorMessage,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

export function toProofView(row: typeof proofs.$inferSelect): ProofView {
  return {
    id: row.recordId,
    state: row.state,
    connectionId: row.connectionId,
    threadId: row.threadId,
    externalId: row.externalId,
    templateId: row.templateId,
    verified: row.verified,
    disclosed: row.disclosed,
    errorMessage: row.errorMessage,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

export function toWalletView(row: typeof wallets.$inferSelect): z.infer<typeof walletView> {
  return {
    id: row.id,
    externalId: row.externalId,
    hasMediatorInvitation: row.mediatorOobId !== null,
    lastSyncRequestedAt: row.lastSyncRequestedAt ? iso(row.lastSyncRequestedAt) : null,
    createdAt: iso(row.createdAt),
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
  }
}
