import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { Form, formValidation, useAppForm } from '@/components/form/form'
import { AuthLayout } from '@/components/shell/auth-layout'
import { type SignInForm, signInForm } from '@/features/session/auth.schemas'
import { ForgotPasswordDialog } from '@/features/session/forgot-password-dialog'
import { authClient } from '@/lib/auth-client'
import { safeRedirect } from '@/lib/redirect'

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({ redirect: safeRedirect(search.redirect) }),
  beforeLoad: ({ context, search }) => {
    if (context.viewer?.twoFactorEnabled) throw redirect({ href: search.redirect ?? '/' })
  },
  component: LoginPage,
})

function LoginPage() {
  const router = useRouter()
  const search = Route.useSearch()
  const [error, setError] = useState<string | null>(null)

  // Until hydration the form has no handler and its submit button is disabled (Form + SubmitButton):
  // a native submit must never send the password anywhere.
  const form = useAppForm({
    defaultValues: { email: '', password: '' } satisfies SignInForm,
    validationLogic: formValidation,
    validators: { onDynamic: signInForm },
    onSubmit: async ({ value }) => {
      setError(null)
      const result = await authClient.signIn.email(signInForm.parse(value))
      if (result.error) {
        // One message for every failure, so the form never reveals whether an account exists.
        setError(result.error.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'Email or password is incorrect.')
        return
      }
      // With 2FA enabled, the two-factor client plugin takes the browser to /verify-2fa itself.
      if (result.data && 'twoFactorRedirect' in result.data && result.data.twoFactorRedirect) return
      await router.invalidate()
      await router.navigate({ href: search.redirect ?? '/' })
    },
  })

  return (
    <AuthLayout title="Sign in" description="Accounts are created by invitation.">
      <Form form={form}>
        <form.FormError error={error} />
        <form.AppField name="email">{(field) => <field.TextField label="Email" type="email" autoComplete="username" autoFocus />}</form.AppField>
        <form.AppField name="password">{(field) => <field.PasswordField label="Password" autoComplete="current-password" />}</form.AppField>
        <form.SubmitButton pendingLabel="Signing in…">Sign in</form.SubmitButton>
      </Form>
      <div className="mt-2 flex justify-center">
        <ForgotPasswordDialog />
      </div>
    </AuthLayout>
  )
}
