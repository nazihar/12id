/**
 * Customer-facing shapes of the mirror rows. Shared by the REST routes (response schemas) and
 * the webhook payloads, so a customer sees one representation everywhere.
 */
import { z } from 'zod'

import { type Gate, biometricView, toBiometricView } from './biometric/gate.ts'
import type { connections, credentials, proofs, wallets } from './db/schema.ts'

export const connectionView = z.object({
  id: z.string(),
  state: z.string(),
  invitationId: z.string().nullable(),
  theirLabel: z.string().nullable(),
  externalId: z.string().nullable(),
  /** When the personal data was erased, on request or by the retention period; null = not erased (Phase 7 H1). */
  erasedAt: z.iso.datetime().nullable(),
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
  /** null when the exchange is not biometric-gated (Phase 6). */
  biometric: biometricView,
  /** When the personal data was erased, on request or by the retention period; null = not erased (Phase 7 H1). */
  erasedAt: z.iso.datetime().nullable(),
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
  /** null when not gated. While a gate has not passed, `verified` and `disclosed` stay null. */
  biometric: biometricView,
  /** When the personal data was erased, on request or by the retention period; null = not erased (Phase 7 H1). */
  erasedAt: z.iso.datetime().nullable(),
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
  /** First time the platform saw the wallet's mediator connection; null = not (yet) connected. */
  connectedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  /** null when revoked by the customer; `never_connected` when the platform revoked it after 7 days without a connection. */
  revokedReason: z.string().nullable(),
})

const iso = (d: Date) => d.toISOString()

export function toConnectionView(row: typeof connections.$inferSelect): ConnectionView {
  return { id: row.recordId, state: row.state, invitationId: row.invitationId, theirLabel: row.theirLabel, externalId: row.externalId, erasedAt: row.erasedAt ? iso(row.erasedAt) : null, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }
}

export function toCredentialView(row: typeof credentials.$inferSelect, gate?: Gate | null): CredentialView {
  return {
    id: row.recordId,
    state: row.state,
    connectionId: row.connectionId,
    threadId: row.threadId,
    externalId: row.externalId,
    credentialDefinitionId: row.credentialDefinitionId,
    attributes: row.attributes,
    errorMessage: row.errorMessage,
    biometric: toBiometricView(gate),
    erasedAt: row.erasedAt ? iso(row.erasedAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

export function toProofView(row: typeof proofs.$inferSelect, gate?: Gate | null): ProofView {
  const withheld = !!gate && gate.status !== 'passed'
  return {
    id: row.recordId,
    state: row.state,
    connectionId: row.connectionId,
    threadId: row.threadId,
    externalId: row.externalId,
    templateId: row.templateId,
    verified: withheld ? null : row.verified,
    disclosed: withheld ? null : row.disclosed,
    errorMessage: row.errorMessage,
    biometric: toBiometricView(gate),
    erasedAt: row.erasedAt ? iso(row.erasedAt) : null,
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
    connectedAt: row.connectedAt ? iso(row.connectedAt) : null,
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
    revokedReason: row.revokedReason,
  }
}

/**
 * The mandatory `expiresAt` attribute (epoch seconds as a string, §5.2) as a Date, or null when it is
 * missing or not a number. Stored on its own (`credentials.expires_at`) so it survives erasure.
 */
export function expiryOf(attributes: Record<string, string> | null | undefined): Date | null {
  const value = attributes?.expiresAt
  if (!value || !/^[0-9]{1,12}$/.test(value)) return null
  return new Date(Number(value) * 1000)
}
