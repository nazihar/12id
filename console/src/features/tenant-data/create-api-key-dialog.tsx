import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { useState } from 'react'

import { Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { SecretOnceDialog } from '@/components/secret-once-dialog'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { type CreateApiKeyInput, createApiKeyInput } from '@/features/tenants/tenants.schemas'
import { type Held, announceHeld, isHeld } from '@/lib/held'

/** Shared by the operator and portal API-key pages; the caller supplies the server function to use. */
export function CreateApiKeyDialog({ createKey, invalidateKey }: { createKey: (label: string) => Promise<{ apiKey: string } | Held>; invalidateKey: QueryKey }) {
  const [secret, setSecret] = useState<string | null>(null)
  return (
    <>
      <FormDialog
        trigger={
          <Button size="sm">
            <PlusIcon />
            Create API key
          </Button>
        }
        title="Create an API key"
        description="Your backend calls the 12id API with it (Authorization: Bearer). The key is shown once, right after it is created."
      >
        {({ close }) => (
          <CreateApiKeyForm
            createKey={createKey}
            invalidateKey={invalidateKey}
            onCreated={(apiKey) => {
              close()
              // null: the key waits for a second person and does not exist yet (implement/22 C17).
              if (apiKey) setSecret(apiKey)
            }}
          />
        )}
      </FormDialog>
      <SecretOnceDialog
        secret={secret}
        title="API key created"
        description="Copy it now and store it in your secret manager. It is shown only once; the platform keeps only a hash."
        onClose={() => setSecret(null)}
      />
    </>
  )
}

function CreateApiKeyForm({ createKey, invalidateKey, onCreated }: { createKey: (label: string) => Promise<{ apiKey: string } | Held>; invalidateKey: QueryKey; onCreated: (apiKey: string | null) => void }) {
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: (input: CreateApiKeyInput) => createKey(input.label),
    onSuccess: (created) => {
      announceHeld(created, queryClient)
      return queryClient.invalidateQueries({ queryKey: invalidateKey })
    },
  })
  const form = useAppForm({
    defaultValues: { label: '' } satisfies CreateApiKeyInput,
    validationLogic: formValidation,
    validators: { onDynamic: createApiKeyInput },
    onSubmit: ({ value }) => submitMutation(create, value, (created) => onCreated(isHeld(created) ? null : created.apiKey)),
  })
  return (
    <Form form={form}>
      <form.FormError error={create.error} />
      <form.AppField name="label">{(field) => <field.TextField label="New key label" placeholder="backend-production" description="Names the system that holds the key, so a revocation later is unambiguous." autoFocus />}</form.AppField>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Creating…">Create API key</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}
