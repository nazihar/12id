import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { inviteOperator } from '@/features/operators/operators.functions'
import { type InviteOperatorInput, inviteOperatorInput } from '@/features/operators/operators.schemas'

export function InviteOperatorDialog() {
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <PlusIcon />
          Add operator
        </Button>
      }
      title="Add an operator"
      description="Operators see every tenant. Add only 12id staff. They receive a link to set a password and must set up an authenticator app at first sign-in."
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
    defaultValues: { name: '', email: '' } satisfies InviteOperatorInput,
    validationLogic: formValidation,
    validators: { onDynamic: inviteOperatorInput },
    onSubmit: ({ value }) => submitMutation(invite, value, onDone),
  })
  return (
    <Form form={form}>
      <form.FormError error={invite.error} />
      <form.AppField name="name">{(field) => <field.TextField label="Name" autoComplete="off" autoFocus />}</form.AppField>
      <form.AppField name="email">{(field) => <field.TextField label="Email" type="email" autoComplete="off" />}</form.AppField>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Sending…">Send invitation</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}
