import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useHydrated, useNavigate } from '@tanstack/react-router'
import type { FormEvent } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { createTenant } from '@/features/tenants/tenants.functions'

export const Route = createFileRoute('/_authed/ops/tenants/new')({ component: NewTenantPage })

function NewTenantPage() {
  const navigate = useNavigate()
  const hydrated = useHydrated()
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: (name: string) => createTenant({ data: { name } }),
    onSuccess: async (tenant) => {
      await queryClient.invalidateQueries({ queryKey: ['ops', 'tenant-overview'] })
      if (tenant.status === 'ready') toast.success(`${tenant.name} is onboarded.`)
      else toast.warning(`${tenant.name} was created but onboarding is ${tenant.status}.`)
      await navigate({ to: '/ops/tenants/$tenantId', params: { tenantId: tenant.id } })
    },
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    create.mutate(String(new FormData(event.currentTarget).get('name')))
  }

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle>New tenant</CardTitle>
        <CardDescription>Creates the tenant and registers its DID on the ledger through the platform endorser. This takes a few seconds.</CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" onSubmit={onSubmit}>
          <FieldGroup>
            {create.error && (
              <Alert variant="destructive">
                <AlertDescription>{create.error.message}</AlertDescription>
              </Alert>
            )}
            <Field>
              <FieldLabel htmlFor="name">Organization name</FieldLabel>
              <Input id="name" name="name" maxLength={200} required />
              <FieldDescription>Shown to operators and used as the tenant's console organization name.</FieldDescription>
            </Field>
            <Button type="submit" disabled={!hydrated || create.isPending}>
              {create.isPending ? 'Onboarding…' : 'Create tenant'}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
