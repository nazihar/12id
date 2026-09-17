import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { Form, formValidation, useAppForm } from '@/components/form/form'
import { AuthLayout } from '@/components/shell/auth-layout'
import { PASSWORD_MIN, type PasswordConfirmForm, passwordConfirmForm } from '@/features/session/auth.schemas'
import { authClient } from '@/lib/auth-client'

const EXPIRED = 'This link has expired or was already used. Ask your operator or organization owner for a new one.'

// Landing page of the emailed link, for a forgotten password and for a new tenant owner's first
// password. Better Auth checks the token and redirects here with ?token= (or ?error=INVALID_TOKEN).
export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>): { token?: string; error?: string } => ({
    token: typeof search.token === 'string' ? search.token : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const { token, error: linkError } = Route.useSearch()
  const router = useRouter()
  const [error, setError] = useState<string | null>(linkError || !token ? EXPIRED : null)

  const form = useAppForm({
    defaultValues: { password: '', confirm: '' } satisfies PasswordConfirmForm,
    validationLogic: formValidation,
    validators: { onDynamic: passwordConfirmForm },
    onSubmit: async ({ value }) => {
      if (!token) return
      setError(null)
      const result = await authClient.resetPassword({ newPassword: value.password, token })
      if (result.error) {
        setError(result.error.code === 'PASSWORD_TOO_SHORT' ? `Use at least ${PASSWORD_MIN} characters.` : EXPIRED)
        return
      }
      await router.navigate({ to: '/login' })
    },
  })

  return (
    <AuthLayout title="Choose your password" description="After this you sign in and set up two-factor authentication.">
      <Form form={form}>
        <form.FormError error={error} />
        <form.AppField name="password">{(field) => <field.PasswordField label="New password" autoComplete="new-password" description={`At least ${PASSWORD_MIN} characters.`} autoFocus />}</form.AppField>
        <form.AppField name="confirm">{(field) => <field.PasswordField label="Repeat the password" autoComplete="new-password" />}</form.AppField>
        <form.SubmitButton pendingLabel="Saving…" disabled={!token}>
          Save password
        </form.SubmitButton>
      </Form>
    </AuthLayout>
  )
}
