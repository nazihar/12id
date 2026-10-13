import { createFileRoute, redirect } from '@tanstack/react-router'

// Sends each visitor to where they belong: sign-in, 2FA setup, the operator console or their account.
export const Route = createFileRoute('/')({
  beforeLoad: ({ context }) => {
    if (!context.viewer) throw redirect({ to: '/login' })
    if (!context.viewer.twoFactorEnabled) throw redirect({ to: '/setup-2fa' })
    if (context.viewer.passwordExpired) throw redirect({ to: '/change-password' })
    throw redirect({ to: context.viewer.isStaff ? '/ops' : '/account' })
  },
})
