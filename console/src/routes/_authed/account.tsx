import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'

import { RouteError } from '@/components/route-error'
import { SignOutButton } from '@/components/sign-out-button'
import { StateBadge } from '@/components/state-badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { myOrganizationsQuery } from '@/features/portal/portal.queries'

export const Route = createFileRoute('/_authed/account')({
  loader: ({ context }) => context.queryClient.ensureQueryData(myOrganizationsQuery()),
  errorComponent: RouteError,
  component: AccountPage,
})

function AccountPage() {
  const { viewer } = Route.useRouteContext()
  const { data: organizations } = useSuspenseQuery(myOrganizationsQuery())
  return (
    <main className="mx-auto max-w-2xl space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-lg font-medium">Your organizations</h1>
          <p className="text-sm text-muted-foreground">Signed in as {viewer.email}</p>
        </div>
        <div className="flex items-center gap-2">
          {viewer.isOperator && (
            <Link to="/ops" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Operator console
            </Link>
          )}
          <SignOutButton />
        </div>
      </div>
      {organizations.length === 0 ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>No organizations yet</CardTitle>
            <CardDescription>Ask your organization's owner to invite you, then open the link in the invitation email.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3" data-testid="organizations">
          {organizations.map((organization) => (
            <Link key={organization.id} to="/t/$orgSlug" params={{ orgSlug: organization.slug }} className="block">
              <Card size="sm" className="transition-colors hover:bg-muted/50">
                <CardContent className="flex items-center justify-between gap-3">
                  <span className="font-medium">{organization.name}</span>
                  <StateBadge state={organization.role} />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  )
}
