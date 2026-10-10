/**
 * smoke:reference-credo. Drives the deployed reference backend (reference/backend, implement/21) the way
 * its app does, with a Credo holder standing in for the SDK: sign in, wallet token, enrol, receive the
 * card, start an action, answer the proof request, read the approval. Everything it checks comes from
 * the backend's own answers, so it proves the whole chain: the backend's API key, the platform, the
 * agent, the mediator and the signed webhooks back to the backend. No tunnel and no phone.
 *
 * Env: REFERENCE_BACKEND (default https://demo.12id.naziharitsolution.com), REFERENCE_ACCESS_CODE,
 * PLATFORM_API (default https://api.12id.naziharitsolution.com).
 */
import './bindings.ts'

import { randomUUID } from 'node:crypto'

import { DidCommCredentialState } from '@credo-ts/didcomm'

import { createHolderAgent, withTimeout } from './common.ts'
import { env, now, platformClient, sleep } from './platform-common.ts'

const backendUrl = env('REFERENCE_BACKEND', 'https://demo.12id.naziharitsolution.com')
const platformUrl = env('PLATFORM_API', 'https://api.12id.naziharitsolution.com')
const name = `Smoke ${new Date().toISOString().slice(0, 19)}`

let sessionToken = ''
async function backend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${backendUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = (await response.json().catch(() => ({}))) as T
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(json)}`)
  return json
}

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`)
    await sleep(1_000)
  }
}

let passed = false
let holder: Awaited<ReturnType<typeof createHolderAgent>> | undefined
try {
  // --- sign in, as the app does ----------------------------------------------------------------
  const refused = await fetch(`${backendUrl}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, accessCode: 'not-the-code', installationId: randomUUID() }) })
  const session = await backend<{ sessionToken: string; user: { id: string; memberId: string; connected: boolean } }>('POST', '/session', { name, accessCode: env('REFERENCE_ACCESS_CODE'), installationId: randomUUID() })
  sessionToken = session.sessionToken
  // A face check needs a live person in front of a phone's camera; a scripted wallet cannot pass one.
  if ((session.user as { photoRequired?: boolean }).photoRequired) {
    console.log('\nThis backend is set to use face checks (tenant.json "photoOnFile"): run the flow on a phone instead.')
    console.log('\n=== smoke:reference-credo SKIPPED ===')
    process.exit(2)
  }
  console.log(`  [${now()}] signed in as "${name}" (member ${session.user.memberId}); a wrong code answered ${refused.status}`)

  // --- the SDK's part: wallet token → mediator ---------------------------------------------------
  const { walletToken } = await backend<{ walletToken: string }>('POST', '/wallet-token', {})
  const again = await backend<{ walletToken: string }>('POST', '/wallet-token', {})
  const invitation = await platformClient(platformUrl, walletToken).must<{ invitationUrl: string }>('GET', '/v1/wallet/mediator-invitation')
  holder = await createHolderAgent('reference-holder', { mediatorInvitationUrl: invitation.invitationUrl })
  console.log(`  [${now()}] wallet token works; holder mediated (same token on a second request: ${again.walletToken === walletToken})`)

  // --- enrol: connect, and the backend offers the card when the platform reports the connection --
  const credentialDone = withTimeout(
    new Promise<void>((resolve) => {
      holder!.events.observable<any>('DidCommCredentialStateChanged').subscribe((e) => {
        if (e.payload.credentialExchangeRecord.state === DidCommCredentialState.Done) resolve()
      })
    }),
    180_000,
    'holder credential done'
  )
  const enrolment = await backend<{ connected: boolean; invitationUrl: string | null }>('POST', '/enrol', {})
  if (!enrolment.invitationUrl) throw new Error('no invitation for a new user')
  const enrolledAt = Date.now()
  await holder.modules.didcomm.oob.receiveInvitationFromUrl(enrolment.invitationUrl, { label: 'reference-holder' })
  await credentialDone
  const me = await until('credential done at the backend', () => backend<{ connected: boolean; credentialState: string | null }>('GET', '/me'), (m) => m.credentialState === 'done')
  console.log(`  [${now()}] card issued ${((Date.now() - enrolledAt) / 1000).toFixed(1)} s after enrol; backend says connected=${me.connected}, credential ${me.credentialState}`)
  const second = await backend<{ connected: boolean; invitationUrl: string | null }>('POST', '/enrol', {})

  // --- the action: the backend asks for a proof, the wallet answers, the backend approves ---------
  const startedAt = Date.now()
  const action = await backend<{ id: string; state: string }>('POST', '/actions', { type: 'transfer', details: { amount: '5000', payee: 'Rahim Traders' } })
  const result = await until('the action to be decided', () => backend<{ state: string; disclosed: Record<string, Record<string, string>> | null; details: Record<string, string> }>('GET', `/actions/${action.id}`), (a) => a.state !== 'pending')
  const disclosed = Object.assign({}, ...Object.values(result.disclosed ?? {})) as Record<string, string>
  console.log(`  [${now()}] action ${result.state} ${((Date.now() - startedAt) / 1000).toFixed(1)} s after the request; disclosed ${JSON.stringify(disclosed)}`)

  console.log('\n=== smoke:reference-credo results ===')
  console.log('wrong access code :', refused.status)
  console.log('wallet            :', again.walletToken === walletToken ? 'one wallet, same token on repeat' : 'TOKEN CHANGED')
  console.log('card              :', me.credentialState)
  console.log('enrol again       :', second.connected && second.invitationUrl === null ? 'already connected, no new invitation' : 'UNEXPECTED')
  console.log('action            :', result.state, JSON.stringify(result.details))
  // The attribute's name is the tenant's choice (tenant.json); its value is this user's member id.
  const memberIdDisclosed = Object.values(disclosed).includes(session.user.memberId)
  console.log('disclosed         :', JSON.stringify(disclosed), `(member id ${memberIdDisclosed ? 'matches' : 'DOES NOT MATCH'})`)
  passed =
    refused.status === 401 &&
    again.walletToken === walletToken &&
    me.connected &&
    me.credentialState === 'done' &&
    second.connected &&
    result.state === 'approved' &&
    memberIdDisclosed &&
    Object.keys(disclosed).length === 1
} catch (error) {
  console.error('SMOKE FAILED:', error)
} finally {
  await sleep(2000)
  await holder?.shutdown().catch(() => undefined)
}
console.log(`\n=== smoke:reference-credo ${passed ? 'PASSED' : 'FAILED'} ===`)
process.exit(passed ? 0 : 1)
