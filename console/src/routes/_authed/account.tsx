import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { BuildingIcon, ChevronRightIcon, ShieldUserIcon } from 'lucide-react'

import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
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
    <section className="mx-auto w-full max-w-2xl space-y-5">
      <PageHeader
        title="Your organizations"
        description={`Signed in as ${viewer.email}.`}
        actions={
          viewer.isStaff && (
            <Link to="/ops" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <ShieldUserIcon />
              Operator console
            </Link>
          )
        }
      />
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
            <Link key={organization.id} to="/t/$orgSlug" params={{ orgSlug: organization.slug }} className="block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <Card size="sm" className="transition-colors hover:bg-muted/50">
                <CardContent className="flex items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <BuildingIcon className="size-4" />
                  </div>
                  <span className="min-w-0 flex-1 truncate font-medium">{organization.name}</span>
                  <StateBadge state={organization.role} />
                  <ChevronRightIcon className="size-4 text-muted-foreground" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}
