import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { createTenantOrganization } from '@/features/tenants/tenant-owner.functions'
import { type CreateTenantOrganizationInput, createTenantOrganizationInput } from '@/features/tenants/tenants.schemas'

/** Operator: creates the tenant's console organization with its first owner, who receives a set-password link. */
export function CreateTenantOrganizationDialog({ tenantId, ready }: { tenantId: string; ready: boolean }) {
  if (!ready) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span tabIndex={0}>
              <Button size="sm" disabled>
                <PlusIcon />
                Create organization
              </Button>
            </span>
          }
        />
        <TooltipContent>Finish onboarding before creating the organization.</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <PlusIcon />
          Create organization
        </Button>
      }
      title="Create the console organization"
      description="Customer staff sign in to the tenant portal through this organization. The owner receives an email with a link to set a password."
    >
      {({ close }) => <CreateTenantOrganizationForm tenantId={tenantId} onDone={close} />}
    </FormDialog>
  )
}

function CreateTenantOrganizationForm({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: (owner: CreateTenantOrganizationInput) => createTenantOrganization({ data: { tenantId, ...owner } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['ops', 'tenant', tenantId, 'organization'] })
      toast.success(result.passwordLinkSent ? `Organization created. ${result.ownerEmail} received a link to set a password.` : `Organization created with ${result.ownerEmail} as owner.`)
    },
  })
  const form = useAppForm({
    defaultValues: { ownerName: '', ownerEmail: '' } satisfies CreateTenantOrganizationInput,
    validationLogic: formValidation,
    validators: { onDynamic: createTenantOrganizationInput },
    onSubmit: ({ value }) => submitMutation(create, value, onDone),
  })
  return (
    <Form form={form}>
      <form.FormError error={create.error} />
      <form.AppField name="ownerName">{(field) => <field.TextField label="Owner name" autoComplete="off" autoFocus />}</form.AppField>
      <form.AppField name="ownerEmail">{(field) => <field.TextField label="Owner email" type="email" autoComplete="off" />}</form.AppField>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Creating…">Create organization</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}
