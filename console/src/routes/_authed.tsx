import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'

import { AppShell } from '@/components/shell/app-shell'
import { myOrganizationsQuery } from '@/features/portal/portal.queries'
import { getShellPreferences } from '@/features/session/session.functions'

// Everything below needs a signed-in user with 2FA turned on. This is navigation UX; the data
// boundary is the middleware on each server function.
export const Route = createFileRoute('/_authed')({
  beforeLoad: ({ context, location }) => {
    if (!context.viewer) throw redirect({ to: '/login', search: { redirect: location.href } })
    if (!context.viewer.twoFactorEnabled) throw redirect({ to: '/setup-2fa' })
    // An expired password is changed before anything else (implement/24).
    if (context.viewer.passwordExpired) throw redirect({ to: '/change-password' })
    return { viewer: context.viewer }
  },
  // The shell needs the organization list (workspace switcher) and the sidebar's remembered state.
  loader: async ({ context }) => {
    const [, preferences] = await Promise.all([context.queryClient.ensureQueryData(myOrganizationsQuery()), getShellPreferences()])
    return preferences
  },
  // Sidebar state is client-owned after the first render; no need to re-read the cookie per navigation.
  staleTime: Infinity,
  component: AuthedLayout,
})

function AuthedLayout() {
  const { sidebarOpen } = Route.useLoaderData()
  return (
    <AppShell sidebarOpen={sidebarOpen}>
      <Outlet />
    </AppShell>
  )
}
