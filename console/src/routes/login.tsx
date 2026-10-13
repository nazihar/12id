import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { useCaptcha } from '@/components/captcha'
import { Form, formValidation, useAppForm } from '@/components/form/form'
import { AuthLayout } from '@/components/shell/auth-layout'
import { type SignInForm, signInForm } from '@/features/session/auth.schemas'
import { ForgotPasswordDialog } from '@/features/session/forgot-password-dialog'
import { authClient } from '@/lib/auth-client'
import { safeRedirect } from '@/lib/redirect'

/** Why the person landed here, when it was not their own choice (implement/24). */
const REASONS: Record<string, string> = {
  idle: 'You were signed out after a period without activity.',
  ended: 'Your session ended. If you did not sign out, your account may have signed in somewhere else.',
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string; reason?: string } => ({
    redirect: safeRedirect(search.redirect),
    reason: typeof search.reason === 'string' && search.reason in REASONS ? search.reason : undefined,
  }),
  beforeLoad: ({ context, search }) => {
    if (context.viewer?.twoFactorEnabled) throw redirect({ href: search.redirect ?? '/' })
  },
  component: LoginPage,
})

function LoginPage() {
  const router = useRouter()
  const search = Route.useSearch()
  const [error, setError] = useState<string | null>(null)
  const { captcha, take } = useCaptcha()

  // Until hydration the form has no handler and its submit button is disabled (Form + SubmitButton):
  // a native submit must never send the password anywhere.
  const form = useAppForm({
    defaultValues: { email: '', password: '' } satisfies SignInForm,
    validationLogic: formValidation,
    validators: { onDynamic: signInForm },
    onSubmit: async ({ value }) => {
      setError(null)
      // Each check is good for one try; take() starts the next one.
      const proof = await take()
      if (!proof) {
        setError('The check that you are not a robot did not finish. Reload the page and try again.')
        return
      }
      // rememberMe false: the session cookie ends with the browser (MTB 2.73).
      const result = await authClient.signIn.email({ ...signInForm.parse(value), rememberMe: false }, { headers: { 'x-captcha': proof } })
      if (result.error) {
        const code = result.error.code
        // One message for a wrong email or password, so the form never reveals whether an account exists.
        // A lock is said: it only happens to an account that exists and was tried many times.
        setError(
          result.error.status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : code === 'ACCOUNT_LOCKED' || code === 'CAPTCHA_REQUIRED'
              ? (result.error.message ?? 'Sign-in refused.')
              : code === 'BANNED_USER'
                ? "This account is disabled. Ask an operator or your organization's owner to enable it."
                : 'Email or password is incorrect.',
        )
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
      {search.reason && !error && <p className="text-muted-foreground mb-3 text-sm">{REASONS[search.reason]}</p>}
      <Form form={form}>
        <form.FormError error={error} />
        <form.AppField name="email">{(field) => <field.TextField label="Email" type="email" autoComplete="username" autoFocus />}</form.AppField>
        <form.AppField name="password">{(field) => <field.PasswordField label="Password" autoComplete="current-password" />}</form.AppField>
        {captcha}
        <form.SubmitButton pendingLabel="Signing in…">Sign in</form.SubmitButton>
      </Form>
      <div className="mt-2 flex justify-center">
        <ForgotPasswordDialog />
      </div>
    </AuthLayout>
  )
}
