import { createFileRoute, useHydrated, useRouter } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldGroup } from '@/components/ui/field'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { authClient } from '@/lib/auth-client'

// Second step of sign-in. Better Auth holds the half-finished sign-in in a short-lived cookie.
export const Route = createFileRoute('/verify-2fa')({ component: VerifyTwoFactorPage })

function VerifyTwoFactorPage() {
  const router = useRouter()
  const hydrated = useHydrated()
  const [method, setMethod] = useState<'totp' | 'otp'>('totp')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function emailCode() {
    setPending(true)
    setError(null)
    const result = await authClient.twoFactor.sendOtp()
    setPending(false)
    if (result.error) {
      setError('Could not send a code. Sign in again.')
      return
    }
    setMethod('otp')
    setCode('')
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const result = method === 'totp' ? await authClient.twoFactor.verifyTotp({ code }) : await authClient.twoFactor.verifyOtp({ code })
    setPending(false)
    if (result.error) {
      setError(result.error.status === 403 ? (result.error.message ?? 'This account must use an authenticator app.') : 'That code did not work. Try again.')
      setCode('')
      return
    }
    await router.invalidate()
    await router.navigate({ to: '/' })
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Two-factor verification</CardTitle>
          <CardDescription>{method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter the 6-digit code we emailed you.'}</CardDescription>
        </CardHeader>
        <CardContent>
          <form method="post" onSubmit={onSubmit}>
            <FieldGroup>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription data-testid="verify-error">{error}</AlertDescription>
                </Alert>
              )}
              <InputOTP maxLength={6} value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" data-testid="otp-code">
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((index) => (
                    <InputOTPSlot key={index} index={index} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
              <Button type="submit" disabled={!hydrated || pending || code.length !== 6}>
                Verify
              </Button>
              {method === 'totp' ? (
                <Button type="button" variant="link" onClick={emailCode} disabled={!hydrated || pending}>
                  Email me a code instead
                </Button>
              ) : (
                <Button type="button" variant="link" onClick={() => setMethod('totp')} disabled={!hydrated || pending}>
                  Use my authenticator app
                </Button>
              )}
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
