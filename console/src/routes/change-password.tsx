import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { Form, formValidation, useAppForm } from '@/components/form/form'
import { AuthLayout } from '@/components/shell/auth-layout'
import { type ChangePasswordForm, changePasswordForm } from '@/features/session/auth.schemas'
import { authClient } from '@/lib/auth-client'

/** Errors the server explains itself (implement/24): its message is shown as it is. */
const SERVER_EXPLAINS = new Set(['PASSWORD_POLICY', 'PASSWORD_REUSED'])

// Changing the password (implement/24). Outside the authed layout on purpose: a person whose password
// has expired is sent here and must not need any other page, whose server functions refuse them.
export const Route = createFileRoute('/change-password')({
  beforeLoad: ({ context }) => {
    if (!context.viewer) throw redirect({ to: '/login', search: { redirect: '/change-password' } })
    if (!context.viewer.twoFactorEnabled) throw redirect({ to: '/setup-2fa' })
    return { viewer: context.viewer }
  },
  component: ChangePasswordPage,
})

function ChangePasswordPage() {
  const { viewer } = Route.useRouteContext()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  const form = useAppForm({
    defaultValues: { currentPassword: '', password: '', confirm: '' } satisfies ChangePasswordForm,
    validationLogic: formValidation,
    validators: { onDynamic: changePasswordForm },
    onSubmit: async ({ value }) => {
      setError(null)
      // Ends every other session of the account; this browser stays signed in.
      const result = await authClient.changePassword({ currentPassword: value.currentPassword, newPassword: value.password, revokeOtherSessions: true })
      if (result.error) {
        const code = result.error.code
        setError(
          code && SERVER_EXPLAINS.has(code)
            ? (result.error.message ?? 'The password was refused.')
            : code === 'INVALID_PASSWORD'
              ? 'Your current password is not right.'
              : 'The password could not be changed. Try again.',
        )
        return
      }
      await router.invalidate()
      await router.navigate({ to: '/' })
    },
  })

  return (
    <AuthLayout
      title={viewer.passwordExpired ? 'Your password has expired' : 'Change your password'}
      description={viewer.passwordExpired ? 'Choose a new password to continue. Your other sessions are signed out.' : 'Your other sessions are signed out when you save.'}
    >
      <Form form={form}>
        <form.FormError error={error} />
        <form.AppField name="currentPassword">{(field) => <field.PasswordField label="Current password" autoComplete="current-password" autoFocus />}</form.AppField>
        <form.AppField name="password">{(field) => <field.NewPasswordField label="New password" person={{ email: viewer.email, name: viewer.name }} />}</form.AppField>
        <form.AppField name="confirm">{(field) => <field.PasswordField label="Repeat the new password" autoComplete="new-password" />}</form.AppField>
        <form.SubmitButton pendingLabel="Saving…">Save password</form.SubmitButton>
      </Form>
    </AuthLayout>
  )
}
