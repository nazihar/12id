import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlusIcon, UserCogIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { type ChoiceOption, Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { RowAction } from '@/components/row-action'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { editOperator, inviteOperator } from '@/features/operators/operators.functions'
import { type EditOperatorInput, type InviteOperatorInput, STAFF_ROLE_HELP, editOperatorInput, inviteOperatorInput } from '@/features/operators/operators.schemas'
import { STAFF_ROLES, type StaffRole } from '@/lib/permissions'

const ROLE_OPTIONS: ChoiceOption<StaffRole>[] = STAFF_ROLES.map((role) => ({ value: role, label: role, description: STAFF_ROLE_HELP[role] }))

export function InviteOperatorDialog() {
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <PlusIcon />
          Add operator
        </Button>
      }
      title="Add an operator or auditor"
      description="Both see every tenant; only an operator can change anything. Add only your own staff. They receive a link to set a password and must set up an authenticator app at first sign-in."
    >
      {({ close }) => <InviteOperatorForm onDone={close} />}
    </FormDialog>
  )
}

function InviteOperatorForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const invite = useMutation({
    mutationFn: (input: InviteOperatorInput) => inviteOperator({ data: input }),
    onSuccess: async (result) => {
      toast.success(`${result.email} received a link to set a password.`)
      await queryClient.invalidateQueries({ queryKey: ['ops', 'operators'] })
    },
  })
  const form = useAppForm({
    defaultValues: { name: '', email: '', role: 'operator' } as InviteOperatorInput,
    validationLogic: formValidation,
    validators: { onDynamic: inviteOperatorInput },
    onSubmit: ({ value }) => submitMutation(invite, value, onDone),
  })
  return (
    <Form form={form}>
      <form.FormError error={invite.error} />
      <form.AppField name="name">{(field) => <field.TextField label="Name" autoComplete="off" autoFocus />}</form.AppField>
      <form.AppField name="email">{(field) => <field.TextField label="Email" type="email" autoComplete="off" />}</form.AppField>
      <form.AppField name="role">{(field) => <field.ComboboxField label="Role" options={ROLE_OPTIONS} />}</form.AppField>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Sending…">Send invitation</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}

/** Row action: the account's name and role in a dialog. The email is the account and does not change. */
export function EditOperatorAction({ operator }: { operator: { id: string; email: string; name: string; role: StaffRole } }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <RowAction label={`Edit ${operator.email}`} icon={UserCogIcon} onClick={() => setOpen(true)} />
      <FormDialog open={open} onOpenChange={setOpen} title={`Edit ${operator.email}`} description="A new role applies to their next request. To change the email address, add a new account and delete this one.">
        {({ close }) => <EditOperatorForm operator={operator} onDone={close} />}
      </FormDialog>
    </>
  )
}

function EditOperatorForm({ operator, onDone }: { operator: { id: string; email: string; name: string; role: StaffRole }; onDone: () => void }) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (input: EditOperatorInput) => editOperator({ data: { userId: operator.id, ...input } }),
    onSuccess: async () => {
      toast.success(`${operator.email} was updated.`)
      await queryClient.invalidateQueries({ queryKey: ['ops', 'operators'] })
    },
  })
  const form = useAppForm({
    defaultValues: { name: operator.name, role: operator.role } as EditOperatorInput,
    validationLogic: formValidation,
    validators: { onDynamic: editOperatorInput },
    onSubmit: ({ value }) => submitMutation(save, value, onDone),
  })
  return (
    <Form form={form}>
      <form.FormError error={save.error} />
      <form.AppField name="name">{(field) => <field.TextField label="Name" autoComplete="off" />}</form.AppField>
      <form.AppField name="role">{(field) => <field.ComboboxField label="Role" options={ROLE_OPTIONS} />}</form.AppField>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Saving…">Save changes</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}
