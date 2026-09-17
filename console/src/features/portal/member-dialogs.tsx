import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlusIcon, UserCogIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { type ChoiceOption, Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { RowAction } from '@/components/row-action'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { changeMemberRole, inviteMember } from '@/features/portal/members.functions'
import { type InviteMemberInput, type MemberRoleInput, ROLE_HELP, TENANT_ROLES, inviteMemberInput, memberRoleInput } from '@/features/portal/members.schemas'
import { portalKey } from '@/features/portal/portal.queries'
import type { TenantRole } from '@/lib/permissions'

const ROLE_OPTIONS: ChoiceOption<TenantRole>[] = TENANT_ROLES.map((role) => ({ value: role, label: role, description: ROLE_HELP[role] }))

export function InviteMemberDialog({ organizationId, orgSlug }: { organizationId: string; orgSlug: string }) {
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <PlusIcon />
          Invite member
        </Button>
      }
      title="Invite someone"
      description="They receive an email, create an account and set up two-factor authentication. The link is valid for 48 hours."
    >
      {({ close }) => <InviteMemberForm organizationId={organizationId} orgSlug={orgSlug} onDone={close} />}
    </FormDialog>
  )
}

function InviteMemberForm({ organizationId, orgSlug, onDone }: { organizationId: string; orgSlug: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const invite = useMutation({
    mutationFn: (input: InviteMemberInput) => inviteMember({ data: { organizationId, ...input } }),
    onSuccess: async (result) => {
      toast.success(`Invitation sent to ${result.email}.`)
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'members') })
    },
  })
  const form = useAppForm({
    defaultValues: { email: '', role: 'member' } as InviteMemberInput,
    validationLogic: formValidation,
    validators: { onDynamic: inviteMemberInput },
    onSubmit: ({ value }) => submitMutation(invite, value, onDone),
  })
  return (
    <Form form={form}>
      <form.FormError error={invite.error} />
      <form.AppField name="email">{(field) => <field.TextField label="Email" type="email" autoComplete="off" autoFocus />}</form.AppField>
      <form.AppField name="role">{(field) => <field.ComboboxField label="Role" options={ROLE_OPTIONS} />}</form.AppField>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Sending…">Send invitation</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}

/** Row action: choose a new role in a dialog, then save. Replaces the select that saved on every change. */
export function ChangeRoleAction({ organizationId, orgSlug, member }: { organizationId: string; orgSlug: string; member: { id: string; email: string; role: TenantRole } }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <RowAction label={`Change role of ${member.email}`} icon={UserCogIcon} onClick={() => setOpen(true)} />
      <FormDialog open={open} onOpenChange={setOpen} title={`Change the role of ${member.email}`} description="The new role applies to their next request.">
        {({ close }) => <ChangeRoleForm organizationId={organizationId} orgSlug={orgSlug} member={member} onDone={close} />}
      </FormDialog>
    </>
  )
}

function ChangeRoleForm({ organizationId, orgSlug, member, onDone }: { organizationId: string; orgSlug: string; member: { id: string; email: string; role: TenantRole }; onDone: () => void }) {
  const queryClient = useQueryClient()
  const change = useMutation({
    mutationFn: (input: MemberRoleInput) => changeMemberRole({ data: { organizationId, memberId: member.id, role: input.role } }),
    onSuccess: async () => {
      toast.success('Role changed.')
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'members') })
    },
  })
  const form = useAppForm({
    defaultValues: { role: member.role } as MemberRoleInput,
    validationLogic: formValidation,
    validators: { onDynamic: memberRoleInput },
    onSubmit: ({ value }) => submitMutation(change, value, onDone),
  })
  return (
    <Form form={form}>
      <form.FormError error={change.error} />
      <form.AppField name="role">{(field) => <field.ComboboxField label="Role" options={ROLE_OPTIONS} />}</form.AppField>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Saving…">Save role</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}
