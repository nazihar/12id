import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'

import { Form, formValidation, useAppForm } from '@/components/form/form'
import { AuthLayout } from '@/components/shell/auth-layout'
import { password } from '@/features/session/auth.schemas'
import { getResetNeedsCode } from '@/features/session/session.functions'
import { authClient } from '@/lib/auth-client'

const EXPIRED = 'This link has expired or was already used. Use "Forgot your password?" on the sign-in page for a new one.'

/** Errors the server explains itself (implement/24): its message is shown as it is. */
const SERVER_EXPLAINS = new Set(['PASSWORD_POLICY', 'PASSWORD_REUSED', 'TOTP_REQUIRED', 'TOTP_WRONG'])

const resetForm = (needsCode: boolean) =>
  z
    .object({ password, confirm: z.string(), code: needsCode ? z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.') : z.string() })
    .superRefine((value, ctx) => {
      if (value.confirm !== value.password) ctx.addIssue({ code: 'custom', path: ['confirm'], message: 'The passwords do not match.' })
    })

// Landing page of the emailed link, for a forgotten password and for a new account's first password.
// Better Auth checks the token and redirects here with ?token= (or ?error=INVALID_TOKEN). An account
// with an authenticator app also gives its code here (MTB 2.33).
export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>): { token?: string; error?: string } => ({
    token: typeof search.token === 'string' ? search.token : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ deps }) => ({ needsCode: deps.token ? (await getResetNeedsCode({ data: { token: deps.token } })).needsCode : false }),
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const { token, error: linkError } = Route.useSearch()
  const { needsCode } = Route.useLoaderData()
  const router = useRouter()
  const [error, setError] = useState<string | null>(linkError || !token ? EXPIRED : null)
  const schema = resetForm(needsCode)

  const form = useAppForm({
    defaultValues: { password: '', confirm: '', code: '' },
    validationLogic: formValidation,
    validators: { onDynamic: schema },
    onSubmit: async ({ value }) => {
      if (!token) return
      setError(null)
      const result = await authClient.resetPassword({ newPassword: value.password, token }, needsCode ? { headers: { 'x-totp-code': value.code } } : undefined)
      if (result.error) {
        setError(result.error.code && SERVER_EXPLAINS.has(result.error.code) ? (result.error.message ?? EXPIRED) : EXPIRED)
        return
      }
      await router.navigate({ to: '/login' })
    },
  })

  return (
    <AuthLayout title="Choose your password" description="After this you sign in with the new password and your second factor.">
      <Form form={form}>
        <form.FormError error={error} />
        <form.AppField name="password">{(field) => <field.NewPasswordField label="New password" autoFocus />}</form.AppField>
        <form.AppField name="confirm">{(field) => <field.PasswordField label="Repeat the password" autoComplete="new-password" />}</form.AppField>
        {needsCode && (
          <form.AppField name="code">
            {(field) => <field.TextField label="Code from your authenticator app" autoComplete="one-time-code" inputMode="numeric" maxLength={6} description="A wrong code ends this link." />}
          </form.AppField>
        )}
        <form.SubmitButton pendingLabel="Saving…" disabled={!token}>
          Save password
        </form.SubmitButton>
      </Form>
    </AuthLayout>
  )
}
