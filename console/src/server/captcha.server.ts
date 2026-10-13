/**
 * The captcha on the login and forgot-password forms (implement/24, MTB rows 2.32 and 2.36): ALTCHA,
 * a proof of work the browser computes and this server checks. Self-hosted: no third party, no
 * tracking, and it works without internet access (a bank's premises).
 *
 * The challenge is signed with keys derived from the auth secret, so there is no new secret. A
 * solution is accepted once (an in-memory store: the console runs as one process).
 *
 * Relative imports only (the Better Auth CLI loads the auth chain outside Vite).
 */
import { createHmac } from 'node:crypto'

import { CappedMap, createChallenge, randomInt } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'
import { verify } from 'altcha-lib/frameworks/shared'

import { serverEnv } from './env.server'

/** The header the forms send the widget's payload in. */
export const CAPTCHA_HEADER = 'x-captcha'
const CHALLENGE_TTL_MS = 10 * 60 * 1000

const keys = (() => {
  let derived: { signature: string; key: string } | undefined
  return () => {
    if (!derived) {
      const secret = serverEnv().BETTER_AUTH_SECRET
      const derive = (purpose: string) => createHmac('sha256', secret).update(`12id-console-captcha:${purpose}`).digest('hex')
      derived = { signature: derive('signature'), key: derive('key') }
    }
    return derived
  }
})()

const spent = new CappedMap<string, boolean>({ maxSize: 10_000 })

/** A new challenge for the widget. */
export async function captchaChallenge() {
  const { signature, key } = keys()
  return createChallenge({
    algorithm: 'PBKDF2/SHA-256',
    // About 0.3 to 0.5 s of work per attempt in a browser (measured in Node, 2026-10-13): nothing a
    // person waits for, a real cost for a script trying passwords.
    cost: 1_000,
    counter: randomInt(2_000, 5_000),
    deriveKey,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    hmacSignatureSecret: signature,
    hmacKeySignatureSecret: key,
  })
}

/** True when the payload solves a challenge we issued, unexpired and not used before. */
export async function captchaSolved(payload: string | null | undefined): Promise<boolean> {
  if (!payload) return false
  const { signature, key } = keys()
  const result = await verify(payload, deriveKey, signature, key, spent).catch(() => null)
  return result !== null && result.error === null
}
