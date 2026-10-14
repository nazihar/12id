/** Create, clone and edit a custom role (implement/26): a name, a description and the portal actions it allows. */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CopyIcon, PencilIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { type ChoiceOption, Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { RowAction } from '@/components/row-action'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { portalKey } from '@/features/portal/portal.queries'
import { createCustomRole, updateCustomRole } from '@/features/portal/roles.functions'
import { type RoleInput, type RoleRow, roleInput } from '@/features/portal/roles.schemas'
import { announceHeld } from '@/lib/held'
import { PORTAL_ACTIONS, type PortalAction } from '@/lib/permissions'

const ACTION_OPTIONS: ChoiceOption<PortalAction>[] = PORTAL_ACTIONS.map((action) => ({ value: action.key, label: action.label, description: action.help }))

type Mode = { kind: 'create' } | { kind: 'clone'; from: RoleRow } | { kind: 'edit'; role: RoleRow }

export function NewRoleDialog({ organizationId, orgSlug }: { organizationId: string; orgSlug: string }) {
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <PlusIcon />
          New role
        </Button>
      }
      title="New role"
      description="Everyone in the organization sees every page. Tick what this role may also change."
      size="md"
    >
      {({ close }) => <RoleForm organizationId={organizationId} orgSlug={orgSlug} mode={{ kind: 'create' }} onDone={close} />}
    </FormDialog>
  )
}

/** Row actions on the Roles page: clone any role; edit a custom one. */
export function RoleRowAction({ organizationId, orgSlug, role, kind }: { organizationId: string; orgSlug: string; role: RoleRow; kind: 'clone' | 'edit' }) {
  const [open, setOpen] = useState(false)
  const mode: Mode = kind === 'clone' ? { kind: 'clone', from: role } : { kind: 'edit', role }
  return (
    <>
      <RowAction label={kind === 'clone' ? `Clone ${role.label}` : `Edit ${role.label}`} icon={kind === 'clone' ? CopyIcon : PencilIcon} onClick={() => setOpen(true)} />
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={kind === 'clone' ? `New role from ${role.label}` : `Edit ${role.label}`}
        description={kind === 'clone' ? 'Starts with the same actions. Give it a name of its own.' : 'The change applies to everyone who holds the role, on their next request.'}
        size="md"
      >
        {({ close }) => <RoleForm organizationId={organizationId} orgSlug={orgSlug} mode={mode} onDone={close} />}
      </FormDialog>
    </>
  )
}

function RoleForm({ organizationId, orgSlug, mode, onDone }: { organizationId: string; orgSlug: string; mode: Mode; onDone: () => void }) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (input: RoleInput) =>
      mode.kind === 'edit' ? updateCustomRole({ data: { organizationId, role: mode.role.role, ...input } }) : createCustomRole({ data: { organizationId, ...input } }),
    onSuccess: async (result) => {
      if (announceHeld(result, queryClient)) return
      toast.success(mode.kind === 'edit' ? 'Role saved.' : 'Role created.')
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'roles') })
    },
  })
  const start: RoleInput =
    mode.kind === 'edit'
      ? { label: mode.role.label, description: mode.role.description, actions: mode.role.actions }
      : mode.kind === 'clone'
        ? { label: '', description: mode.from.description, actions: mode.from.actions }
        : { label: '', description: '', actions: [] }
  const form = useAppForm({
    defaultValues: start,
    validationLogic: formValidation,
    validators: { onDynamic: roleInput },
    onSubmit: ({ value }) => submitMutation(save, value, onDone),
  })
  return (
    <Form form={form}>
      <form.FormError error={save.error} />
      <form.AppField name="label">{(field) => <field.TextField label="Name" autoComplete="off" autoFocus placeholder="Integrations" />}</form.AppField>
      <form.AppField name="description">{(field) => <field.TextareaField label="Description" rows={2} placeholder="What people with this role do." />}</form.AppField>
      <form.AppField name="actions">{(field) => <field.CheckboxGroupField label="May also" options={ACTION_OPTIONS} stacked />}</form.AppField>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Saving…">{mode.kind === 'edit' ? 'Save role' : 'Create role'}</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}
