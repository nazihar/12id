import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { PlusIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { createTenant } from '@/features/tenants/tenants.functions'
import { type CreateTenantInput, createTenantInput } from '@/features/tenants/tenants.schemas'

/** Operator: creates a tenant and onboards it on the ledger, then opens it. */
export function CreateTenantDialog() {
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <PlusIcon />
          New tenant
        </Button>
      }
      title="New tenant"
      description="Creates the tenant and registers its DID on the ledger through the platform endorser. This takes a few seconds."
    >
      {({ close }) => <CreateTenantForm onDone={close} />}
    </FormDialog>
  )
}

function CreateTenantForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: (input: CreateTenantInput) => createTenant({ data: input }),
    onSuccess: async (tenant) => {
      await queryClient.invalidateQueries({ queryKey: ['ops', 'tenant-overview'] })
      if (tenant.status === 'ready') toast.success(`${tenant.name} is onboarded.`)
      else toast.warning(`${tenant.name} was created but onboarding is ${tenant.status}.`)
    },
  })
  const form = useAppForm({
    defaultValues: { name: '' } satisfies CreateTenantInput,
    validationLogic: formValidation,
    validators: { onDynamic: createTenantInput },
    onSubmit: ({ value }) =>
      submitMutation(create, value, async (tenant) => {
        onDone()
        await navigate({ to: '/ops/tenants/$tenantId', params: { tenantId: tenant.id } })
      }),
  })
  return (
    <Form form={form}>
      <form.FormError error={create.error} />
      <form.AppField name="name">{(field) => <field.TextField label="Organization name" description="Shown to operators and used as the tenant's console organization name." autoFocus />}</form.AppField>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Onboarding on the ledger…">Create tenant</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}
