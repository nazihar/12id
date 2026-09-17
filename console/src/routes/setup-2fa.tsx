import { createFileRoute, redirect, useHydrated, useRouter } from '@tanstack/react-router'
import QRCode from 'qrcode'
import { type FormEvent, useState } from 'react'

import { Form, formValidation, useAppForm } from '@/components/form/form'
import { AuthLayout } from '@/components/shell/auth-layout'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { confirmPasswordForm } from '@/features/session/auth.schemas'
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

type Method = 'totp' | 'otp'

function SetupTwoFactorPage() {
  const { viewer } = Route.useRouteContext()
  const router = useRouter()
  const hydrated = useHydrated()
  const [enrollment, setEnrollment] = useState<{ secret: string; qr: string; backupCodes: string[] } | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // One form, two submit buttons: the pressed one passes its method through handleSubmit's meta.
  const form = useAppForm({
    defaultValues: { password: '' },
    validationLogic: formValidation,
    validators: { onDynamic: confirmPasswordForm },
    onSubmitMeta: { method: 'totp' as Method },
    onSubmit: async ({ value, meta }) => {
      const useEmail = meta.method === 'otp' && !viewer.isOperator
      setError(null)
      const result = useEmail ? await authClient.twoFactor.enable({ password: value.password, method: 'otp' }) : await authClient.twoFactor.enable({ password: value.password })
      if (result.error) {
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
    },
  })

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
    <AuthLayout size="md" title="Set up two-factor authentication" description={viewer.isOperator ? 'Operator accounts use an authenticator app.' : 'Use an authenticator app, or receive codes by email.'}>
      {!enrollment ? (
        <Form form={form}>
          <form.FormError error={error} />
          <form.AppField name="password">{(field) => <field.PasswordField label="Confirm your password" autoComplete="current-password" autoFocus />}</form.AppField>
          <form.SubmitButton pendingLabel="Checking…">Use an authenticator app</form.SubmitButton>
          {!viewer.isOperator && (
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(isSubmitting) => (
                <Button type="button" variant="outline" disabled={!hydrated || isSubmitting} onClick={() => void form.handleSubmit({ method: 'otp' })}>
                  Email me codes instead
                </Button>
              )}
            </form.Subscribe>
          )}
        </Form>
      ) : (
        <form method="post" onSubmit={confirm}>
          <FieldGroup>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <img src={enrollment.qr} alt="QR code for your authenticator app" className="mx-auto size-48 rounded-md bg-white p-1" />
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
    </AuthLayout>
  )
}
