/**
 * The vendor port (15-phase-6-biometric.md "Port"). Everything vendor-specific lives behind it;
 * a new vendor is one adapter here plus one device add-on per platform.
 *
 * Scores crossing the port are normalized to 0–100. Adapters never make the pass/fail decision:
 * checks.ts applies the check's thresholds.
 */
import type { z } from 'zod'

export interface ProviderContext {
  tenantId: string
  /** Decrypted, validated tenant configuration. */
  config: Record<string, unknown>
  /** Our per-tenant external id (AWS trust-policy condition). */
  externalId: string
}

export type SessionOutcome =
  /** The vendor has not finished (e.g. the device is still streaming). The session may be completed again. */
  | { status: 'pending' }
  /** The vendor itself rejected the session. */
  | { status: 'failed'; reason: 'vendor_failed' | 'vendor_expired'; raw: Record<string, unknown> }
  | {
      status: 'ready'
      livenessScore: number
      /** Face image captured during liveness; compared against the reference, never stored. */
      probeImage: Buffer
      /** Set when the vendor matched in the same call; otherwise matchFaces runs. */
      matchScore?: number | null
      raw: Record<string, unknown>
    }

export interface BiometricProvider {
  id: string
  displayName: string
  /** Validates the tenant configuration; its JSON Schema is served to the console. */
  configSchema: z.ZodType<Record<string, unknown>>
  /** Which device add-on runs the capture. */
  captureModule: { provider: string; minVersion: number }
  /** The fields that may be shown back to the console. */
  publicConfig(config: Record<string, unknown>): Record<string, unknown>
  testConnection(ctx: ProviderContext): Promise<void>
  createSession(ctx: ProviderContext, input: { checkId: string; attempt: number }): Promise<{ vendorSessionId: string; clientConfig: unknown }>
  completeSession(ctx: ProviderContext, input: { vendorSessionId: string; clientOutput: unknown }): Promise<SessionOutcome>
  /** null when either image has no detectable face. */
  matchFaces(ctx: ProviderContext, reference: Buffer, probe: Buffer): Promise<{ matchScore: number | null; raw: Record<string, unknown> }>
}

/** A provider-side failure worth reporting to the caller as a client error (bad config, access denied). */
export class ProviderError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
  }
}
