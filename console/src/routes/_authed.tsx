import { createFileRoute, redirect } from '@tanstack/react-router'

// Everything below needs a signed-in user with 2FA turned on. This is navigation UX; the data
// boundary is the middleware on each server function.
export const Route = createFileRoute('/_authed')({
  beforeLoad: ({ context, location }) => {
    if (!context.viewer) throw redirect({ to: '/login', search: { redirect: location.href } })
    if (!context.viewer.twoFactorEnabled) throw redirect({ to: '/setup-2fa' })
    return { viewer: context.viewer }
  },
})
