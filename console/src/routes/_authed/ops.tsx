import { Link, Outlet, createFileRoute, redirect } from '@tanstack/react-router'

import { SignOutButton } from '@/components/sign-out-button'

export const Route = createFileRoute('/_authed/ops')({
  beforeLoad: ({ context }) => {
    if (!context.viewer.isOperator) throw redirect({ to: '/account' })
  },
  component: OperatorLayout,
})

const NAV = [
  { to: '/ops', label: 'Tenants', exact: true },
  { to: '/ops/deliveries', label: 'Dead deliveries', exact: false },
  { to: '/ops/audit', label: 'Audit log', exact: false },
  { to: '/ops/operators', label: 'Operators', exact: false },
] as const

function OperatorLayout() {
  const { viewer } = Route.useRouteContext()
  return (
    <div className="min-h-svh">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-3">
        <div className="flex flex-wrap items-center gap-6">
          <Link to="/ops" className="font-heading font-medium">
            12id Console · Operators
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            {NAV.map((item) => (
              <Link key={item.to} to={item.to} activeOptions={{ exact: item.exact }} className="text-muted-foreground hover:text-foreground" activeProps={{ className: 'font-medium text-foreground' }}>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>{viewer.email}</span>
          <SignOutButton />
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-6">
        <Outlet />
      </main>
    </div>
  )
}
