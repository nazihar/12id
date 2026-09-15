import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useHydrated } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import type { FormEvent } from 'react'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { RouteError } from '@/components/route-error'
import { StateBadge } from '@/components/state-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { banOperator, inviteOperator, listOperators, revokeOperatorSessions, unbanOperator } from '@/features/operators/operators.functions'
import { formatDateTime } from '@/lib/format'

type OperatorRow = Awaited<ReturnType<typeof listOperators>>[number]

const operatorsQuery = () => queryOptions({ queryKey: ['ops', 'operators'], queryFn: () => listOperators() })

export const Route = createFileRoute('/_authed/ops/operators')({
  loader: ({ context }) => context.queryClient.ensureQueryData(operatorsQuery()),
  errorComponent: RouteError,
  component: OperatorsPage,
})

function OperatorsPage() {
  const { viewer } = Route.useRouteContext()
  const { data } = useSuspenseQuery(operatorsQuery())
  return (
    <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
      <section className="space-y-3">
        <h1 className="font-heading text-lg font-medium">Operators</h1>
        <DataTable columns={operatorColumns(viewer.userId)} data={data} emptyMessage="No operators." testId="operators-table" />
      </section>
      <InviteOperatorCard />
    </div>
  )
}

const column = createColumnHelper<DataTableFeatures, OperatorRow>()

function operatorColumns(currentUserId: string) {
  return column.columns([
    column.accessor('name', { header: 'Name' }),
    column.accessor('email', { header: 'Email' }),
    column.accessor((row) => (row.banned ? 'banned' : 'active'), { id: 'status', header: 'Status', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
    column.accessor('createdAt', { header: 'Created', cell: ({ getValue }) => formatDateTime(getValue()) }),
    column.display({ id: 'actions', header: '', cell: ({ row }) => (row.original.id === currentUserId ? <span className="text-xs text-muted-foreground">you</span> : <OperatorActions operator={row.original} />) }),
  ])
}

function OperatorActions({ operator }: { operator: OperatorRow }) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['ops', 'operators'] })
  const ban = useMutation({ mutationFn: () => banOperator({ data: { userId: operator.id } }), onSuccess: async () => { toast.success(`${operator.email} is banned and signed out.`); await refresh() }, onError: (error) => toast.error(error.message) })
  const unban = useMutation({ mutationFn: () => unbanOperator({ data: { userId: operator.id } }), onSuccess: async () => { toast.success(`${operator.email} can sign in again.`); await refresh() }, onError: (error) => toast.error(error.message) })
  const revoke = useMutation({ mutationFn: () => revokeOperatorSessions({ data: { userId: operator.id } }), onSuccess: () => toast.success(`Signed ${operator.email} out everywhere.`), onError: (error) => toast.error(error.message) })
  return (
    <div className="flex gap-1">
      <Button size="sm" variant="ghost" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
        Sign out everywhere
      </Button>
      {operator.banned ? (
        <Button size="sm" variant="outline" onClick={() => unban.mutate()} disabled={unban.isPending}>
          Unban
        </Button>
      ) : (
        <Button size="sm" variant="destructive" onClick={() => ban.mutate()} disabled={ban.isPending}>
          Ban
        </Button>
      )}
    </div>
  )
}

function InviteOperatorCard() {
  const hydrated = useHydrated()
  const queryClient = useQueryClient()
  const invite = useMutation({
    mutationFn: (input: { email: string; name: string }) => inviteOperator({ data: input }),
    onSuccess: async (result) => {
      toast.success(`${result.email} received a link to set a password. They must set up an authenticator app at first sign-in.`)
      await queryClient.invalidateQueries({ queryKey: ['ops', 'operators'] })
    },
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    invite.mutate({ email: String(values.get('email')), name: String(values.get('name')) }, { onSuccess: () => form.reset() })
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Add an operator</CardTitle>
        <CardDescription>Operators see every tenant. Add only 12id staff.</CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" onSubmit={onSubmit}>
          <FieldGroup>
            {invite.error && (
              <Alert variant="destructive">
                <AlertDescription>{invite.error.message}</AlertDescription>
              </Alert>
            )}
            <Field>
              <FieldLabel htmlFor="operator-name">Name</FieldLabel>
              <Input id="operator-name" name="name" maxLength={200} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="operator-email">Email</FieldLabel>
              <Input id="operator-email" name="email" type="email" required />
            </Field>
            <Button type="submit" disabled={!hydrated || invite.isPending}>
              Send invitation
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
