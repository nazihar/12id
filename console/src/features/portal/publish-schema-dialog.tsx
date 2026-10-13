import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { type PublishSchemaForm, parseAttributeList, publishSchemaForm } from '@/features/portal/catalogue.schemas'
import { publishSchema } from '@/features/portal/portal-data.functions'
import { portalKey } from '@/features/portal/portal.queries'
import { announceHeld } from '@/lib/held'
import { EXPIRY_ATTRIBUTE } from '@/lib/template-schema'

export function PublishSchemaDialog({ organizationId, orgSlug }: { organizationId: string; orgSlug: string }) {
  return (
    <FormDialog
      size="md"
      trigger={
        <Button size="sm">
          <PlusIcon />
          Publish a schema
        </Button>
      }
      title="Publish a schema"
      description="Schemas are public and permanent on the ledger: you cannot add or rename attributes later, only publish a new version. Values are strings; attributes used in predicates must hold whole numbers."
    >
      {({ close }) => <PublishSchemaFormBody organizationId={organizationId} orgSlug={orgSlug} onDone={close} />}
    </FormDialog>
  )
}

function PublishSchemaFormBody({ organizationId, orgSlug, onDone }: { organizationId: string; orgSlug: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const publish = useMutation({
    mutationFn: (input: PublishSchemaForm) => publishSchema({ data: { organizationId, ...publishSchemaForm.parse(input) } }),
    onSuccess: async (schema) => {
      if (announceHeld(schema, queryClient)) return
      toast.success(`${schema.name} ${schema.version} published. Publish its credential definition to start issuing.`)
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'catalogue') })
    },
  })
  const form = useAppForm({
    defaultValues: { name: '', version: '1.0', attributes: '' } satisfies PublishSchemaForm,
    validationLogic: formValidation,
    validators: { onDynamic: publishSchemaForm },
    onSubmit: ({ value }) => submitMutation(publish, value, onDone),
  })
  return (
    <Form form={form}>
      <form.FormError error={publish.error} />
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <form.AppField name="name">{(field) => <field.TextField label="Name" placeholder="employee-badge" autoFocus />}</form.AppField>
        <form.AppField name="version">{(field) => <field.TextField label="Version" placeholder="1.0" />}</form.AppField>
      </div>
      <form.AppField name="attributes">
        {(field) => (
          <field.TextareaField
            label="Attributes"
            rows={4}
            mono
            placeholder={'name\ndepartment\nemployeeNumber'}
            description={`One per line or separated by commas. ${EXPIRY_ATTRIBUTE} (the expiry date, YYYYMMDD) is added to every schema: credentials expire instead of being revoked.`}
          />
        )}
      </form.AppField>
      <form.Subscribe selector={(state) => state.values.attributes}>
        {(text) => {
          const names = parseAttributeList(text)
          return names.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1 text-sm">
              <span className="text-muted-foreground">Will publish:</span>
              {[...names, EXPIRY_ATTRIBUTE].map((name) => (
                <Badge key={name} variant={name === EXPIRY_ATTRIBUTE ? 'secondary' : 'outline'}>
                  {name}
                </Badge>
              ))}
            </div>
          ) : null
        }}
      </form.Subscribe>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Publishing on the ledger…">Publish schema</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}
