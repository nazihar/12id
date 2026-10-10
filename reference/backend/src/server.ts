/**
 * The routes: what the app calls, and the webhook 12id calls. The flow is the SDK guide's recipe
 * "issue at sign-in, prove before an action":
 *
 *   app  POST /session       sign in (a stand-in for your own sign-in)
 *   app  POST /wallet-token  the SDK asks for this installation's wallet token
 *   app  POST /photo         the user's photo on file (only where the organisation uses face checks)
 *   app  POST /enrol         an invitation to connect; the credential offer follows by webhook
 *   app  POST /actions       something that needs the user's proof (e.g. a transfer)
 *   app  GET  /actions/:id   the result
 *   12id POST /webhooks/12id signed events: connection, credential, proof, wallet
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { Config } from './config.ts'
import { type Platform, PlatformError } from './platform.ts'
import type { Action, Store, User } from './store.ts'
import { faceReference, handleEvent, offerCredential, verifySignature, type WebhookEvent } from './webhooks.ts'

export interface AppDeps {
  config: Config
  platform: Platform
  store: Store
  log: (message: string) => void
}

class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const sameSecret = (a: string, b: string) => timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)))

export function createApp(deps: AppDeps): Server {
  const { config, platform, store, log } = deps
  const { tenant } = config

  /** Your own sign-in goes here. This one takes a name and a shared code, and keeps one user per installation. */
  function signIn(body: Record<string, unknown>) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const installationId = typeof body.installationId === 'string' ? body.installationId : ''
    if (typeof body.accessCode !== 'string' || !sameSecret(body.accessCode, config.accessCode)) throw new HttpError(401, 'wrong_access_code')
    if (name.length < 1 || name.length > 100 || !/^[0-9a-fA-F-]{36}$/.test(installationId)) throw new HttpError(400, 'invalid_request')

    const sessionToken = randomBytes(32).toString('base64url')
    const existing = store.findUser((user) => user.installationId === installationId)
    const user = store.saveUser({
      ...(existing ?? {
        id: randomUUID(),
        name,
        memberId: String(randomInt(10_000_000, 100_000_000)),
        installationId,
        walletId: null,
        walletToken: null,
        walletGeneration: 0,
        connectionId: null,
        credentialState: null,
      }),
      sessionTokenHash: sha256(sessionToken),
    })
    return { sessionToken, user: publicUser(user) }
  }

  /**
   * The wallet token for this installation. The platform shows a token once, so we keep it and hand the
   * same one back. `refresh` is what the app sends when the SDK reports the token was rejected: the
   * same Idempotency-Key then returns the same wallet with a new token (for 24 hours; after that the
   * platform has forgotten the key and creates a new wallet).
   */
  async function walletToken(user: User, refresh: boolean): Promise<string> {
    if (user.walletToken && !refresh) return user.walletToken
    for (let generation = user.walletGeneration; ; generation += 1) {
      try {
        const wallet = await platform.createWallet(user.id, `${user.installationId}:${generation}`)
        store.saveUser({ ...store.user(user.id)!, walletId: wallet.id, walletToken: wallet.walletToken, walletGeneration: generation })
        return wallet.walletToken
      } catch (error) {
        // 409 wallet_revoked: that wallet is gone for good; the next key creates a new one.
        const revoked = error instanceof PlatformError && error.status === 409 && (error.body as { error?: string }).error === 'wallet_revoked'
        if (!revoked || generation > user.walletGeneration) throw error
      }
    }
  }

  /** True while the organisation uses face checks and we hold no photo of this user yet. */
  const photoRequired = (user: User) => tenant.photoOnFile === true && store.photo(user.id) === null

  const publicUser = (user: User) => ({ id: user.id, name: user.name, memberId: user.memberId, connected: user.connectionId !== null, credentialState: user.credentialState, photoRequired: photoRequired(user) })

  /**
   * The photo a face check compares the live face with. A real organisation took it when it verified
   * the customer; here the app sends one at the first sign-in. It never goes to the wallet: the backend
   * sends it to 12id with each offer and proof request, and 12id deletes it once the check is decided.
   */
  function savePhoto(user: User, body: Record<string, unknown>) {
    const image = Buffer.from(typeof body.image === 'string' ? body.image : '', 'base64')
    const jpeg = image.length > 3 && image[0] === 0xff && image[1] === 0xd8
    const png = image.length > 8 && image.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    if (!(jpeg || png) || image.length > 1_000_000) throw new HttpError(400, 'invalid_photo')
    store.savePhoto(user.id, image)
    return publicUser(user)
  }

  /** First time: an invitation for the SDK's connect(). The offer is sent when the connection completes (webhooks.ts). */
  async function enrol(user: User) {
    if (photoRequired(user)) throw new HttpError(409, 'photo_required')
    if (!user.connectionId) {
      const invitation = await platform.createInvitation(user.id)
      return { connected: false, invitationUrl: invitation.invitationUrl }
    }
    // Already connected. If no card is on its way (the offer was refused, declined or timed out), offer again.
    if (user.credentialState === null || user.credentialState === 'abandoned') await offerCredential({ platform, store, tenant }, user, user.connectionId)
    return { connected: true, invitationUrl: null }
  }

  /** Something the user must prove before we do it. The proof request goes to the user's wallet; the answer arrives by webhook. */
  async function startAction(user: User, body: Record<string, unknown>) {
    const type = typeof body.type === 'string' ? body.type : ''
    const template = Object.hasOwn(tenant.actions, type) ? tenant.actions[type] : undefined
    if (!template) throw new HttpError(400, 'unknown_action')
    if (!user.connectionId) throw new HttpError(409, 'not_enrolled')
    const details: Record<string, string> = {}
    for (const [key, value] of Object.entries((body.details ?? {}) as Record<string, unknown>).slice(0, 10)) details[key.slice(0, 50)] = String(value).slice(0, 200)

    const action = store.saveAction({ id: randomUUID(), userId: user.id, type, details, state: 'pending', proofId: null, disclosed: null, createdAt: new Date().toISOString() })
    try {
      const proof = await platform.requestProof({ connectionId: user.connectionId, templateId: template.proofTemplateId, externalId: action.id, ...faceReference(store, user) }, `action:${action.id}`)
      return publicAction(store.saveAction({ ...store.action(action.id)!, proofId: proof.id }))
    } catch (error) {
      store.saveAction({ ...store.action(action.id)!, state: 'failed' })
      // The template requires a face check and we hold no photo of this user.
      if (error instanceof PlatformError && error.status === 422 && (error.body as { error?: string }).error === 'biometric_reference_required') throw new HttpError(409, 'photo_required')
      throw error
    }
  }

  async function webhook(request: IncomingMessage, rawBody: string) {
    // Check the signature on the raw bytes, before parsing anything.
    if (!verifySignature(config.webhookSecret, String(request.headers['x-12id-signature'] ?? ''), rawBody)) throw new HttpError(401, 'bad_signature')
    await handleEvent({ platform, store, tenant, log }, JSON.parse(rawBody) as WebhookEvent)
    return { ok: true }
  }

  function authenticated(request: IncomingMessage): User {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
    const user = token ? store.findUser((candidate) => candidate.sessionTokenHash === sha256(token)) : undefined
    if (!user) throw new HttpError(401, 'not_signed_in')
    return user
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost')
    const is = (method: string, path: string) => request.method === method && pathname === path

    if (is('GET', '/healthz')) return { ok: true }
    if (is('GET', '/app') && config.appDownloadUrl) {
      response.writeHead(302, { location: config.appDownloadUrl }).end()
      return undefined
    }
    if (is('POST', '/webhooks/12id')) return webhook(request, await readBody(request, 1_000_000))
    if (is('POST', '/session')) return signIn(await readJson(request))

    if (is('GET', '/me')) return publicUser(authenticated(request))
    if (is('POST', '/wallet-token')) {
      const user = authenticated(request)
      return { walletToken: await walletToken(user, (await readJson(request)).refresh === true) }
    }
    if (is('POST', '/photo')) return savePhoto(authenticated(request), await readJson(request, 1_500_000))
    if (is('POST', '/enrol')) return enrol(authenticated(request))
    if (is('POST', '/actions')) return startAction(authenticated(request), await readJson(request))
    const actionId = /^\/actions\/([0-9a-f-]{36})$/.exec(pathname)?.[1]
    if (request.method === 'GET' && actionId) {
      const user = authenticated(request)
      const action = store.action(actionId)
      if (!action || action.userId !== user.id) throw new HttpError(404, 'not_found')
      return publicAction(action)
    }
    throw new HttpError(404, 'not_found')
  }

  return createServer((request, response) => {
    route(request, response)
      .then((body) => {
        if (body !== undefined) send(response, 200, body)
      })
      .catch((error: unknown) => {
        if (error instanceof HttpError) return send(response, error.status, { error: error.code })
        // The detail stays in our log; the app only learns that 12id could not be reached or refused.
        log(`${request.method} ${request.url}: ${error instanceof Error ? error.message : String(error)}`)
        send(response, error instanceof PlatformError ? 502 : 500, { error: error instanceof PlatformError ? 'platform_error' : 'internal_error' })
      })
  })
}

const publicAction = (action: Action) => ({ id: action.id, type: action.type, details: action.details, state: action.state, disclosed: action.disclosed })

function send(response: ServerResponse, status: number, body: unknown) {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, 'too_large'))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

async function readJson(request: IncomingMessage, limit = 64_000): Promise<Record<string, unknown>> {
  const raw = await readBody(request, limit)
  if (!raw) return {}
  try {
    const body: unknown = JSON.parse(raw)
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // falls through
  }
  throw new HttpError(400, 'invalid_json')
}
