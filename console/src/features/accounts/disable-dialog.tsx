/**
 * Disable an account (operators) or a membership (owners) until a day or until re-enabled, with a note
 * saying why (implement/26). One dialog for both; the caller says what is disabled and runs it.
 */
import { BanIcon } from 'lucide-react'
import { useState } from 'react'

import { Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { RowAction } from '@/components/row-action'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { type DisableInput, disableInput } from '@/features/operators/operators.schemas'
import { formatDateTime } from '@/lib/format'

const startOfToday = () => {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

export function DisableAction({ who, what, onDisable }: { who: string; what: string; onDisable: (input: DisableInput) => Promise<unknown> }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <RowAction label="Disable" icon={BanIcon} onClick={() => setOpen(true)} />
      <FormDialog open={open} onOpenChange={setOpen} title={`Disable ${who}?`} description={what}>
        {({ close }) => <DisableForm onDisable={onDisable} onDone={close} />}
      </FormDialog>
    </>
  )
}

function DisableForm({ onDisable, onDone }: { onDisable: (input: DisableInput) => Promise<unknown>; onDone: () => void }) {
  const [error, setError] = useState<Error | null>(null)
  const mutation = {
    mutateAsync: async (input: DisableInput) => {
      setError(null)
      try {
        return await onDisable(input)
      } catch (caught) {
        setError(caught instanceof Error ? caught : new Error('The account could not be disabled.'))
        throw caught
      }
    },
  }
  const form = useAppForm({
    defaultValues: { until: '', note: '' } as DisableInput,
    validationLogic: formValidation,
    validators: { onDynamic: disableInput },
    onSubmit: ({ value }) => submitMutation(mutation, value, onDone),
  })
  return (
    <Form form={form}>
      <form.FormError error={error} />
      <form.AppField name="until">
        {(field) => <field.DateField label="Until" placeholder="Until someone re-enables it" clearLabel="Until someone re-enables it" disabledDays={{ before: new Date(startOfToday().getTime() + 24 * 60 * 60 * 1000) }} description="Empty: until someone re-enables it. A day: it opens again at the start of that day (UTC)." />}
      </form.AppField>
      <form.AppField name="note">{(field) => <field.TextareaField label="Why" rows={2} placeholder="On leave until March" />}</form.AppField>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Disabling…" variant="destructive">
          Disable
        </form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}

/** "until 1 March 2027 · on leave" under the state, for a disabled row. */
export function DisabledDetail({ disabled }: { disabled: { until: string | null; note: string } | null }) {
  if (!disabled) return null
  return (
    <div className="mt-0.5 max-w-56 truncate text-xs text-muted-foreground" title={disabled.note}>
      {disabled.until ? `until ${formatDateTime(disabled.until)}` : 'until re-enabled'}
      {disabled.note && ` · ${disabled.note}`}
    </div>
  )
}
