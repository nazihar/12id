/**
 * Typed client for agent-service's internal API (Phase 2 command routes + Phase 3 outbox feed).
 * Every call is scoped by the agent tenant id; the platform never talks to Credo directly.
 *
 * 4xx answers from the agent carry `{ error, reason }` and are surfaced as AgentError with the
 * same status, so customer-facing routes can pass the reason through. 5xx and network failures
 * become generic 502s.
 */
import { INTERNAL_TOKEN_HEADER } from '@12id/credo-base/internal-token.ts'

export class AgentError extends Error {
  public readonly status: number
  public readonly code: string

  public constructor(status: number, code: string, reason: string) {
    super(reason)
    this.name = 'AgentError'
    this.status = status
    this.code = code
  }
}

export interface AgentTenant {
  tenantId: string
  label?: string
  status: string
  did: string | null
  lastError?: string | null
}

export interface AgentLedgerObject {
  id: string
  kind: 'schema' | 'credential_definition'
  name: string
  version: string
  tag: string
  status: string
  qualifiedId: string | null
  unqualifiedId: string | null
  lastError: string | null
  schemaObjectId?: string | null
  attributes?: string[] | null
}

export interface AgentConnection {
  id: string
  state: string
  theirLabel: string | null
  outOfBandId: string | null
  createdAt: string
}

export interface AgentCredential {
  id: string
  state: string
  threadId: string
  connectionId: string | null
  errorMessage: string | null
  credentialDefinitionId: string | null
  attributes: Record<string, string>
}

export interface AgentProof {
  id: string
  state: string
  threadId: string
  connectionId: string | null
  isVerified: boolean | null
  errorMessage: string | null
  disclosed: Record<string, Record<string, string>>
}

export interface AgentProofGroup {
  key: string
  attributes: string[]
  credentialDefinitionIds: string[]
  predicates?: Array<{ name: string; type: '>=' | '>' | '<=' | '<'; value: number }>
}

export interface OutboxRow {
  id: number
  tenantId: string
  recordType: 'connection' | 'credential' | 'proof'
  recordId: string
  threadId: string | null
  state: string
  previousState: string | null
  correlationId: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface AgentClientOptions {
  baseUrl: string
  token: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export function createAgentClient(options: AgentClientOptions) {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await doFetch(new URL(path, options.baseUrl), {
        method,
        // No content-type without a body: Fastify rejects an empty JSON body outright.
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), [INTERNAL_TOKEN_HEADER]: options.token },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new AgentError(502, 'agent_unreachable', `agent-service unreachable: ${(error as Error).message}`)
    }
    const json = (await response.json().catch(() => ({}))) as { error?: string; reason?: string }
    if (response.ok) return json as T
    if (response.status >= 400 && response.status < 500) {
      throw new AgentError(response.status, json.error ?? 'agent_error', json.reason ?? `agent-service answered ${response.status}`)
    }
    throw new AgentError(502, 'agent_error', `agent-service ${method} ${path} failed with HTTP ${response.status}`)
  }

  const t = (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}`

  return {
    createTenant: (label: string) => call<{ tenantId: string; status: string }>('POST', '/tenants', { label }),
    onboardTenant: (tenantId: string) => call<AgentTenant>('POST', `${t(tenantId)}/onboard`),
    getTenant: (tenantId: string) => call<AgentTenant>('GET', t(tenantId)),

    publishSchema: (tenantId: string, input: { name: string; version: string; attributes: string[] }) =>
      call<AgentLedgerObject>('POST', `${t(tenantId)}/schemas`, input),
    publishCredentialDefinition: (tenantId: string, input: { schemaObjectId: string; tag: string }) =>
      call<AgentLedgerObject>('POST', `${t(tenantId)}/credential-definitions`, input),
    listCatalogue: (tenantId: string) => call<AgentLedgerObject[]>('GET', `${t(tenantId)}/catalogue`),
    setSchemaDeprecated: (tenantId: string, schemaObjectId: string, deprecated: boolean) =>
      call<{ status: string }>('POST', `${t(tenantId)}/schemas/${schemaObjectId}/deprecation`, { deprecated }),

    createInvitation: (tenantId: string, input: { multiUse: boolean; correlationId?: string; alias?: string }) =>
      call<{ outOfBandId: string; invitationUrl: string; multiUse: boolean }>('POST', `${t(tenantId)}/invitations`, input),
    listConnections: (tenantId: string, outOfBandId?: string) =>
      call<AgentConnection[]>('GET', `${t(tenantId)}/connections${outOfBandId ? `?outOfBandId=${encodeURIComponent(outOfBandId)}` : ''}`),
    getConnection: (tenantId: string, id: string) => call<AgentConnection>('GET', `${t(tenantId)}/connections/${encodeURIComponent(id)}`),

    offerCredential: (tenantId: string, input: { connectionId: string; credentialDefinitionObjectId: string; values: Record<string, string>; correlationId?: string }) =>
      call<{ credentialExchangeId: string; threadId: string; state: string }>('POST', `${t(tenantId)}/credentials/offer`, input),
    getCredential: (tenantId: string, id: string) => call<AgentCredential>('GET', `${t(tenantId)}/credentials/${encodeURIComponent(id)}`),

    requestProof: (tenantId: string, input: { connectionId: string; name: string; groups: AgentProofGroup[]; correlationId?: string }) =>
      call<{ proofExchangeId: string; threadId: string; state: string }>('POST', `${t(tenantId)}/proofs/request`, input),
    getProof: (tenantId: string, id: string) => call<AgentProof>('GET', `${t(tenantId)}/proofs/${encodeURIComponent(id)}`),

    readOutbox: (afterId: number, limit: number) => call<{ rows: OutboxRow[] }>('GET', `/outbox?afterId=${afterId}&limit=${limit}`),
    ackOutbox: (upToId: number) => call<{ acknowledged: number }>('POST', '/outbox/ack', { upToId }),

    /** Reachability for /readyz. */
    healthy: async () => {
      try {
        const response = await doFetch(new URL('/readyz', options.baseUrl), { signal: AbortSignal.timeout(3_000) })
        return response.ok
      } catch {
        return false
      }
    },
  }
}

export type AgentClient = ReturnType<typeof createAgentClient>
