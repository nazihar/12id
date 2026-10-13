/**
 * The browser half of the idle timeout (implement/24, MTB 2.25). The server ends a session after
 * CONSOLE_IDLE_TIMEOUT_MINUTES without activity; only what this component reports counts as activity,
 * so pages that refresh themselves in the background never keep a session alive.
 *
 * - A pointer, key, wheel or touch event is activity; it is reported at most once a minute.
 * - Two minutes before the limit a dialog asks whether the person is still there. Before it opens,
 *   and before signing out, the server is asked when the session was last active, so activity in
 *   another tab of the same session counts.
 */
import { useNavigate, useRouteContext } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { touchSession } from '@/features/session/session.functions'
import { authClient } from '@/lib/auth-client'
import { ACTIVITY_REPORT_MS, IDLE_WARNING_MS } from '@/lib/sign-in-rules'

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
const CHECK_EVERY_MS = 10_000

function remaining(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function IdleGuard() {
  const { viewer, queryClient } = useRouteContext({ from: '/_authed' })
  const navigate = useNavigate()
  const limitMs = viewer.idleTimeoutMinutes * 60 * 1000
  const lastActivity = useRef(Date.now())
  const lastReported = useRef(0)
  const [warning, setWarning] = useState(false)
  const [now, setNow] = useState(Date.now())

  const signedOut = useCallback(
    async (reason: 'idle' | 'ended') => {
      queryClient.clear()
      await navigate({ to: '/login', search: { reason } })
    },
    [navigate, queryClient],
  )

  const report = useCallback(async () => {
    lastReported.current = Date.now()
    const result = await touchSession({ data: { active: true } }).catch(() => null)
    if (result && !result.signedIn) await signedOut('ended')
  }, [signedOut])

  // What the server knows: the latest activity of this session in any tab.
  const serverLastActive = useCallback(async () => {
    const result = await touchSession({ data: { active: false } }).catch(() => null)
    if (!result) return null
    if (!result.signedIn) {
      await signedOut('idle')
      return null
    }
    return result.lastActiveAt ? new Date(result.lastActiveAt).getTime() : null
  }, [signedOut])

  useEffect(() => {
    const onActivity = () => {
      lastActivity.current = Date.now()
      if (Date.now() - lastReported.current >= ACTIVITY_REPORT_MS) void report()
    }
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { passive: true })
    // Opening a page is activity too.
    void report()
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity)
    }
  }, [report])

  useEffect(() => {
    let checking = false
    const timer = window.setInterval(async () => {
      setNow(Date.now())
      if (checking) return
      const idleFor = Date.now() - lastActivity.current
      if (idleFor < limitMs - IDLE_WARNING_MS) {
        if (warning) setWarning(false)
        return
      }
      checking = true
      try {
        const server = await serverLastActive()
        if (server !== null && server > lastActivity.current) lastActivity.current = server
        const stillIdle = Date.now() - lastActivity.current
        if (stillIdle >= limitMs) {
          await authClient.signOut().catch(() => undefined)
          await signedOut('idle')
        } else {
          setWarning(stillIdle >= limitMs - IDLE_WARNING_MS)
        }
      } finally {
        checking = false
      }
    }, CHECK_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [limitMs, serverLastActive, signedOut, warning])

  return (
    <AlertDialog open={warning} onOpenChange={(open) => !open && setWarning(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you still there?</AlertDialogTitle>
          <AlertDialogDescription>
            You will be signed out in {remaining(limitMs - (now - lastActivity.current))} because the console has not been used for a while.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => {
              void authClient.signOut().then(() => signedOut('idle'))
            }}
          >
            Sign out
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              lastActivity.current = Date.now()
              setWarning(false)
              void report()
            }}
          >
            Stay signed in
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
