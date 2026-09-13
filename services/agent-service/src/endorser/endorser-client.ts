/** HTTP client for endorser-service, validated against the shared contract (D5). */
import {
  type EndorseBody,
  INTERNAL_TOKEN_HEADER,
  bindTenantResponse,
  endorseResponse,
  refusalResponse,
} from '@12id/credo-base/endorsement-contract.ts'

export class EndorsementRefusedError extends Error {
  public readonly status: number

  public constructor(status: number, reason: string) {
    super(`endorser-service refused (${status}): ${reason}`)
    this.name = 'EndorsementRefusedError'
    this.status = status
  }
}

export interface EndorserClient {
  bindTenant(tenantId: string, nym: string): Promise<'bound' | 'already_bound'>
  endorse(body: EndorseBody): Promise<string>
}

export function createEndorserClient(options: { baseUrl: string; token: string; timeoutMs?: number }): EndorserClient {
  async function post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, options.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: options.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    })
    const json = (await response.json().catch(() => ({}))) as unknown
    if (response.ok) return json
    const refusal = refusalResponse.safeParse(json)
    if (refusal.success) throw new EndorsementRefusedError(response.status, refusal.data.reason)
    throw new Error(`endorser-service ${path} failed with HTTP ${response.status}`)
  }

  return {
    async bindTenant(tenantId, nym) {
      return bindTenantResponse.parse(await post('/tenants/bind', { tenantId, nym })).result
    },
    async endorse(body) {
      return endorseResponse.parse(await post('/endorse', body)).endorsedRequest
    },
  }
}
