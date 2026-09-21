/**
 * Deterministic provider for tests, smokes and the console spec. Enabled only with
 * BIOMETRIC_ENABLE_MOCK=true, never in production.
 *
 * The device (or a smoke script) answers with `clientOutput: { live, face }`:
 *   live: false          → liveness 20 (fails any sensible threshold)
 *   face: 'same'         → match 99
 *   face: 'other'        → match 12
 *   face: 'none'         → no face in the probe
 */
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type { BiometricProvider } from './types.ts'

const clientOutputSchema = z.object({ live: z.boolean(), face: z.enum(['same', 'other', 'none']) })

const MARKER = 'mock-probe:'

export const mockProvider: BiometricProvider = {
  id: 'mock',
  displayName: 'Mock (testing only)',
  configSchema: z.object({}).strict(),
  captureModule: { provider: 'mock', minVersion: 1 },
  publicConfig: () => ({}),
  async testConnection() {},
  async createSession(_ctx, input) {
    const vendorSessionId = `mock-${randomUUID()}`
    return { vendorSessionId, clientConfig: { sessionId: vendorSessionId, attempt: input.attempt } }
  },
  async completeSession(_ctx, input) {
    const parsed = clientOutputSchema.safeParse(input.clientOutput)
    if (!parsed.success) return { status: 'pending' }
    return {
      status: 'ready',
      livenessScore: parsed.data.live ? 97 : 20,
      probeImage: Buffer.from(`${MARKER}${parsed.data.face}`),
      raw: { mock: true, live: parsed.data.live },
    }
  },
  async matchFaces(_ctx, _reference, probe) {
    const face = probe.toString('utf8').replace(MARKER, '')
    if (face === 'none') return { matchScore: null, raw: { mock: true } }
    return { matchScore: face === 'same' ? 99 : 12, raw: { mock: true } }
  },
}
