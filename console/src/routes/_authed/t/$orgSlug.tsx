import { Link, Outlet, createFileRoute } from '@tanstack/react-router'

import { RouteError } from '@/components/route-error'
import { SignOutButton } from '@/components/sign-out-button'
import { StateBadge } from '@/components/state-badge'
import { activateOrganization } from '@/features/portal/portal-session.functions'

// Tenant portal. Opening an organization's URL makes it the session's active organization, which is
// what the tenant middleware reads; a non-member gets an error instead.
export const Route = createFileRoute('/_authed/t/$orgSlug')({
  beforeLoad: async ({ params }) => ({ organization: await activateOrganization({ data: { slug: params.orgSlug } }) }),
  errorComponent: RouteError,
  component: PortalLayout,
})

const TABS = [
  { to: '/t/$orgSlug/catalogue', label: 'Catalogue' },
  { to: '/t/$orgSlug/templates', label: 'Proof templates' },
  { to: '/t/$orgSlug/exchanges', label: 'Exchanges' },
  { to: '/t/$orgSlug/wallets', label: 'Wallets' },
  { to: '/t/$orgSlug/webhooks', label: 'Webhooks' },
  { to: '/t/$orgSlug/api-keys', label: 'API keys' },
  { to: '/t/$orgSlug/members', label: 'Members' },
] as const

function PortalLayout() {
  const { organization, viewer } = Route.useRouteContext()
  const { orgSlug } = Route.useParams()
  return (
    <div className="min-h-svh">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <Link to="/account" className="text-sm text-muted-foreground hover:text-foreground">
            12id Console
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="font-heading font-medium">{organization.name}</span>
          <StateBadge state={organization.role} />
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>{viewer.email}</span>
          <SignOutButton />
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-5 p-6">
        <nav className="flex flex-wrap gap-1 border-b pb-2 text-sm" aria-label="Organization sections">
          {TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              params={{ orgSlug }}
              className="rounded-md px-2.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              activeProps={{ className: 'bg-muted font-medium text-foreground' }}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <Outlet />
      </main>
    </div>
  )
}
