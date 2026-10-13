/**
 * The proof-of-work check on the sign-in forms (implement/24, MTB 2.32): ALTCHA's widget, loaded in
 * the browser only. It fetches a signed challenge from our server, solves it in a worker from our own
 * origin (CSP `worker-src 'self'`), and hands the payload to the form, which sends it in the
 * `x-captcha` header. Nothing leaves for a third party.
 *
 * A payload is accepted once. Forms use `useCaptcha()`: `take()` waits for the check to finish (a click
 * can come before it does), hands over the payload and starts a fresh check for the next attempt.
 */
import 'altcha/altcha.css'

import type {} from 'altcha/types/react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { getCaptchaChallenge } from '@/features/session/session.functions'

type Widget = HTMLElementTagNameMap['altcha-widget']

let loading: Promise<void> | undefined

/** Registers the custom element and its PBKDF2 worker once per page. */
function loadWidget(): Promise<void> {
  loading ??= (async () => {
    const [, { default: Pbkdf2Worker }] = await Promise.all([import('altcha/external'), import('altcha/workers/pbkdf2?worker')])
    const altcha = (globalThis as unknown as { $altcha: { algorithms: Map<string, () => Worker> } }).$altcha
    altcha.algorithms.set('PBKDF2/SHA-256', () => new Pbkdf2Worker())
  })()
  return loading
}

function Captcha({ onChange, resetKey = 0 }: { onChange: (payload: string | null) => void; resetKey?: number }) {
  const ref = useRef<Widget | null>(null)
  const [failed, setFailed] = useState(false)
  const latest = useRef(onChange)
  latest.current = onChange

  useEffect(() => {
    let cancelled = false
    const widget = ref.current
    if (!widget) return
    const onState = (event: Event) => {
      const detail = (event as CustomEvent<{ state: string; payload?: string }>).detail
      latest.current(detail.state === 'verified' && detail.payload ? detail.payload : null)
      // A challenge left on the page past its 10 minutes is replaced.
      if (detail.state === 'expired' && !cancelled) void start()
    }
    const start = async () => {
      latest.current(null)
      try {
        await loadWidget()
        const challenge = await getCaptchaChallenge()
        if (cancelled) return
        await widget.configure({ challenge: challenge as never, auto: 'off', hideFooter: true, hideLogo: true })
        widget.reset()
        await widget.verify()
        setFailed(false)
      } catch {
        if (!cancelled) setFailed(true)
      }
    }
    widget.addEventListener('statechange', onState)
    void start()
    return () => {
      cancelled = true
      widget.removeEventListener('statechange', onState)
    }
  }, [resetKey])

  return (
    <div className="flex flex-col gap-1">
      <altcha-widget ref={ref} suppressHydrationWarning data-testid="captcha" />
      {failed && <p className="text-destructive text-xs">The check could not run. Reload the page and try again.</p>}
    </div>
  )
}

const TAKE_TIMEOUT_MS = 10_000

/** The check for one form: render `captcha` inside it, and `await take()` before sending. Null when it did not finish. */
export function useCaptcha(): { captcha: ReactNode; take: () => Promise<string | null> } {
  const payload = useRef<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const onChange = useCallback((value: string | null) => {
    payload.current = value
  }, [])
  const take = useCallback(async () => {
    const deadline = Date.now() + TAKE_TIMEOUT_MS
    while (!payload.current && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    const taken = payload.current
    payload.current = null
    setAttempt((n) => n + 1)
    return taken
  }, [])
  return { captcha: <Captcha onChange={onChange} resetKey={attempt} />, take }
}
