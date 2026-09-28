/**
 * Typed client for biometric-service's internal API (Phase 6 B3), modeled on agent-client.ts.
 * Contract: @12id/credo-base/biometric-contract.ts. 4xx answers pass through as BiometricError
 * with the service's code; 5xx and network failures become 502.
 */
import {
  INTERNAL_TOKEN_HEADER,
  type CheckResponse,
  type CompleteSessionResponse,
  type CreateCheckBody,
  type TenantProviderResponse,
} from '@12id/credo-base/biometric-contract.ts'

export class BiometricError extends Error {
  public readonly status: number
  public readonly code: string

  public constructor(status: number, code: string, reason: string) {
    super(reason)
    this.name = 'BiometricError'
    this.status = status
    this.code = code
  }
}

export interface ProviderCatalogueEntry {
  id: string
  displayName: string
  configSchema: Record<string, unknown>
  captureModule: { provider: string; minVersion: number }
}

export interface StartedSession {
  sessionId: string
  vendorSessionId: string
  providerId: string
  captureModule: { provider: string; minVersion: number }
  clientConfig: unknown
  attempt: number
  attemptsRemaining: number
}

export interface BiometricClientOptions {
  baseUrl: string
  token: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export function createBiometricClient(options: BiometricClientOptions) {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000

  async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await doFetch(new URL(path, options.baseUrl), {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), [INTERNAL_TOKEN_HEADER]: options.token },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new BiometricError(502, 'biometric_unreachable', `biometric-service unreachable: ${(error as Error).message}`)
    }
    if (response.status === 204) return undefined as T
    const json = (await response.json().catch(() => ({}))) as { error?: string; reason?: string }
    if (response.ok) return json as T
    if (response.status >= 400 && response.status < 500) {
      throw new BiometricError(response.status, json.error ?? 'biometric_error', json.reason ?? `biometric-service answered ${response.status}`)
    }
    // 502 from the service means the vendor failed; keep its code for the log, answer 502.
    throw new BiometricError(502, json.error ?? 'biometric_error', json.reason ?? `biometric-service ${method} ${path} failed with HTTP ${response.status}`)
  }

  const t = (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}`

  return {
    providers: () => call<{ providers: ProviderCatalogueEntry[] }>('GET', '/providers'),
    getProvider: (tenantId: string) => call<TenantProviderResponse>('GET', `${t(tenantId)}/provider`),
    putProvider: (tenantId: string, providerId: string, config: Record<string, unknown>) =>
      call<TenantProviderResponse>('PUT', `${t(tenantId)}/provider`, { providerId, config }),
    deleteProvider: (tenantId: string) => call<void>('DELETE', `${t(tenantId)}/provider`),
    testProvider: (tenantId: string) => call<{ status: 'ok' | 'failed' | 'untested'; error: string | null }>('POST', `${t(tenantId)}/provider/test`),

    createCheck: (body: CreateCheckBody) => call<{ checkId: string; providerId: string; expiresAt: string }>('POST', '/checks', body),
    getCheck: (checkId: string) => call<CheckResponse>('GET', `/checks/${checkId}`),
    cancelCheck: (checkId: string) => call<void>('DELETE', `/checks/${checkId}`),
    /** Phase 7 H1: keeps the decision, removes scores, vendor values, hashes and vendor session ids. */
    eraseCheck: (checkId: string) => call<{ erased: boolean }>('POST', `/checks/${checkId}/erase`),
    startSession: (checkId: string) => call<StartedSession>('POST', `/checks/${checkId}/sessions`),
    completeSession: (sessionId: string, clientOutput: unknown) => call<CompleteSessionResponse>('POST', `/sessions/${sessionId}/complete`, { clientOutput }),

    healthy: async () => {
      try {
        const response = await doFetch(new URL('/healthz', options.baseUrl), { signal: AbortSignal.timeout(3_000) })
        return response.ok
      } catch {
        return false
      }
    },
  }
}

export type BiometricClient = ReturnType<typeof createBiometricClient>
