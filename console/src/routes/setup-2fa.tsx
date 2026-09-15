import { createFileRoute, redirect, useHydrated, useRouter } from '@tanstack/react-router'
import QRCode from 'qrcode'
import { type FormEvent, useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { authClient } from '@/lib/auth-client'

// Required before anything else (the console middleware refuses sessions without 2FA).
// Operators must use an authenticator app; tenant members may choose emailed codes instead.
export const Route = createFileRoute('/setup-2fa')({
  beforeLoad: ({ context }) => {
    if (!context.viewer) throw redirect({ to: '/login' })
    if (context.viewer.twoFactorEnabled) throw redirect({ to: '/' })
    return { viewer: context.viewer }
  },
  component: SetupTwoFactorPage,
})

function SetupTwoFactorPage() {
  const { viewer } = Route.useRouteContext()
  const router = useRouter()
  const hydrated = useHydrated()
  const [enrollment, setEnrollment] = useState<{ secret: string; qr: string; backupCodes: string[] } | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
    const password = String(new FormData(event.currentTarget).get('password'))
    const useEmail = submitter?.value === 'otp' && !viewer.isOperator
    setPending(true)
    setError(null)
    const result = useEmail ? await authClient.twoFactor.enable({ password, method: 'otp' }) : await authClient.twoFactor.enable({ password })
    if (result.error) {
      setPending(false)
      setError('Password is incorrect.')
      return
    }
    if (useEmail) {
      await router.invalidate()
      await router.navigate({ to: '/' })
      return
    }
    const totpURI = (result.data as { totpURI: string }).totpURI
    const backupCodes = (result.data as { backupCodes: string[] }).backupCodes
    const secret = new URL(totpURI).searchParams.get('secret') ?? ''
    setEnrollment({ secret, qr: await QRCode.toDataURL(totpURI), backupCodes })
    setPending(false)
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const result = await authClient.twoFactor.verifyTotp({ code })
    setPending(false)
    if (result.error) {
      setError('That code did not work. Check the time on your phone and try again.')
      setCode('')
      return
    }
    await router.invalidate()
    await router.navigate({ to: '/' })
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Set up two-factor authentication</CardTitle>
          <CardDescription>{viewer.isOperator ? 'Operator accounts use an authenticator app.' : 'Use an authenticator app, or receive codes by email.'}</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {!enrollment ? (
            <form method="post" onSubmit={start}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="password">Confirm your password</FieldLabel>
                  <Input id="password" name="password" type="password" autoComplete="current-password" required />
                </Field>
                <Button type="submit" value="totp" disabled={!hydrated || pending}>
                  Use an authenticator app
                </Button>
                {!viewer.isOperator && (
                  <Button type="submit" value="otp" variant="outline" disabled={!hydrated || pending}>
                    Email me codes instead
                  </Button>
                )}
              </FieldGroup>
            </form>
          ) : (
            <form method="post" onSubmit={confirm}>
              <FieldGroup>
                <img src={enrollment.qr} alt="QR code for your authenticator app" className="mx-auto size-48" />
                <Field>
                  <FieldLabel>Can't scan it? Enter this key</FieldLabel>
                  <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all" data-testid="totp-secret">
                    {enrollment.secret}
                  </code>
                </Field>
                <Field>
                  <FieldLabel>Backup codes</FieldLabel>
                  <FieldDescription>Store these now. Each works once if you lose your phone; they are not shown again.</FieldDescription>
                  <ul className="grid grid-cols-2 gap-1 font-mono text-xs" data-testid="backup-codes">
                    {enrollment.backupCodes.map((backupCode) => (
                      <li key={backupCode}>{backupCode}</li>
                    ))}
                  </ul>
                </Field>
                <Field>
                  <FieldLabel>Code from your app</FieldLabel>
                  <InputOTP maxLength={6} value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" data-testid="otp-code">
                    <InputOTPGroup>
                      {[0, 1, 2, 3, 4, 5].map((index) => (
                        <InputOTPSlot key={index} index={index} />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </Field>
                <Button type="submit" disabled={!hydrated || pending || code.length !== 6}>
                  Turn on two-factor authentication
                </Button>
              </FieldGroup>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
