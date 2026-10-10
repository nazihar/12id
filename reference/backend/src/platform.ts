/**
 * The 12id platform API calls a customer backend makes. Each is one HTTPS request with the
 * organisation's API key; the key is what tells the platform which organisation is calling.
 * Reference: https://docs.12id.com (API reference).
 */

export class PlatformError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(method: string, path: string, status: number, body: unknown) {
    super(`${method} ${path} answered ${status} ${JSON.stringify(body)}`)
    this.status = status
    this.body = body
  }
}

/**
 * The photo the user's live face is compared with (base64 JPEG or PNG, one face). Where the
 * organisation's policy requires a face check, a command without it is refused with 422
 * `biometric_reference_required`; 12id deletes the image as soon as the check is decided.
 */
export interface FaceReference {
  referenceImage: string
}

export interface Platform {
  createWallet(externalId: string, idempotencyKey: string): Promise<{ id: string; walletToken: string }>
  createInvitation(externalId: string): Promise<{ invitationId: string; invitationUrl: string }>
  offerCredential(input: { connectionId: string; credentialDefinitionId: string; attributes: Record<string, string>; externalId: string; biometric?: FaceReference }, idempotencyKey: string): Promise<{ id: string; state: string }>
  requestProof(input: { connectionId: string; templateId: string; externalId: string; biometric?: FaceReference }, idempotencyKey: string): Promise<{ id: string; state: string }>
}

export function platformClient(baseUrl: string, apiKey: string): Platform {
  async function post<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        // A retry with the same key returns the first answer instead of doing the work twice.
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const json = (await response.json().catch(() => ({}))) as T
    if (!response.ok) throw new PlatformError('POST', path, response.status, json)
    return json
  }

  return {
    // One wallet per app installation. `externalId` is our own reference; the platform never learns who the user is.
    createWallet: (externalId, idempotencyKey) => post('/v1/wallets', { externalId }, idempotencyKey),
    // The invitation the app passes to the SDK's connect(). `externalId` comes back on the connection's webhooks.
    createInvitation: (externalId) => post('/v1/connections/invitations', { externalId }),
    // Asynchronous: the answer is the exchange record; progress arrives as credential.state_changed webhooks.
    offerCredential: (input, idempotencyKey) => post('/v1/credentials/offer', input, idempotencyKey),
    // Asynchronous: the result arrives as proof.state_changed with `verified` and `disclosed`.
    requestProof: (input, idempotencyKey) => post('/v1/proofs/request', input, idempotencyKey),
  }
}
