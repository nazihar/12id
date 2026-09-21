/**
 * Creating gated exchanges (Phase 6 B3): policy lookup, the check in biometric-service, the agent
 * command with `hold: true`, and the gate row + first log entry. Used by the offer and proof
 * request routes.
 */
import { and, eq } from 'drizzle-orm'

import { BiometricError, type BiometricClient } from '../biometric-client.ts'
import type { Database } from '../db/client.ts'
import { biometricSettings, credentialDefinitionPolicies, exchangeGateEvents, exchangeGates, proofTemplates } from '../db/schema.ts'
import { PlatformError } from '../http/errors.ts'
import { type EffectivePolicy, resolvePolicy } from './policy.ts'

export type PolicySource = { kind: 'credentialDefinition'; id: string } | { kind: 'template'; id: string | null }

export async function effectivePolicy(db: Database, tenantId: string, source: PolicySource): Promise<EffectivePolicy | null> {
  const [settings] = await db.select().from(biometricSettings).where(eq(biometricSettings.tenantId, tenantId))
  if (!settings?.enabled) return null
  let override: unknown = null
  if (source.kind === 'credentialDefinition') {
    const [row] = await db.select().from(credentialDefinitionPolicies).where(and(eq(credentialDefinitionPolicies.tenantId, tenantId), eq(credentialDefinitionPolicies.credentialDefinitionId, source.id)))
    override = row?.biometricPolicy ?? null
  } else if (source.id) {
    const [row] = await db.select({ policy: proofTemplates.biometricPolicy }).from(proofTemplates).where(and(eq(proofTemplates.tenantId, tenantId), eq(proofTemplates.id, source.id)))
    override = row?.policy ?? null
  }
  return resolvePolicy(settings, override)
}

export interface GatedCommand<T> {
  /** Sends the agent command; `hold` is true when gated. */
  send(hold: boolean): Promise<T>
  recordOf(result: T): { recordId: string; threadId: string }
  /** Writes the mirror row inside the gate's transaction. */
  mirror(tx: Parameters<Parameters<Database['transaction']>[0]>[0], result: T): Promise<void>
}

/**
 * Runs an exchange command, gated when a policy applies. The check is created before the offer
 * leaves (so a failing reference image refuses the command), and cancelled if the agent call fails.
 */
export async function runGated<T>(
  deps: { db: Database; biometric?: BiometricClient },
  input: { tenantId: string; recordType: 'credential' | 'proof'; policy: EffectivePolicy | null; referenceImage?: string },
  command: GatedCommand<T>
): Promise<T> {
  const { policy } = input
  if (!policy || !deps.biometric) {
    const result = await command.send(false)
    await deps.db.transaction((tx) => command.mirror(tx, result))
    return result
  }
  if (!input.referenceImage) {
    throw new PlatformError(422, 'biometric_reference_required', 'this exchange requires a biometric check: send biometric.referenceImage (base64 JPEG or PNG, at most 5 MB)')
  }

  let check
  try {
    check = await deps.biometric.createCheck({
      tenantId: input.tenantId,
      purpose: input.recordType === 'credential' ? 'issue' : 'proof',
      referenceImage: input.referenceImage,
      thresholds: { minLivenessScore: policy.minLivenessScore, minMatchScore: policy.minMatchScore },
      maxAttempts: policy.maxAttempts,
      ttlSeconds: policy.ttlMinutes * 60,
    })
  } catch (error) {
    if (error instanceof BiometricError && error.status < 500) {
      const status = error.code === 'invalid_reference_image' ? 400 : 409
      throw new PlatformError(status, error.code === 'invalid_reference_image' ? error.code : `biometric_${error.code}`, error.message)
    }
    throw error
  }

  let result: T
  try {
    result = await command.send(true)
  } catch (error) {
    await deps.biometric.cancelCheck(check.checkId).catch(() => undefined)
    throw error
  }

  const { recordId, threadId } = command.recordOf(result)
  await deps.db.transaction(async (tx) => {
    await command.mirror(tx, result)
    const [gate] = await tx
      .insert(exchangeGates)
      .values({
        tenantId: input.tenantId,
        recordType: input.recordType,
        recordId,
        threadId,
        checkId: check.checkId,
        providerId: check.providerId,
        maxAttempts: policy.maxAttempts,
        thresholds: { minLivenessScore: policy.minLivenessScore, minMatchScore: policy.minMatchScore },
        expiresAt: new Date(check.expiresAt),
      })
      .returning()
    await tx.insert(exchangeGateEvents).values({
      gateId: gate!.id,
      tenantId: input.tenantId,
      type: 'gate_created',
      providerId: check.providerId,
      thresholds: gate!.thresholds,
    })
  })
  return result
}
