import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GaugeIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { setTenantRateLimit } from '@/features/tenants/tenants.functions'
import { type RateLimitInput, rateLimitInput } from '@/features/tenants/tenants.schemas'

/** Operator: the tenant's per-API-key request limit (platform review M4). */
export function RateLimitCard({ tenantId, rateLimitPerMin }: { tenantId: string; rateLimitPerMin: number | null }) {
  const current = rateLimitPerMin === null ? 'Platform default' : rateLimitPerMin === 0 ? 'No limit' : `${rateLimitPerMin} per minute`
  return (
    <Card>
      <CardHeader>
        <CardTitle>API request limit</CardTitle>
        <CardDescription>Requests per minute for each of this tenant's API keys: {current}. Raise it for a busy integration; the console itself is not limited.</CardDescription>
        <CardAction>
          <FormDialog
            trigger={
              <Button size="sm" variant="outline">
                <GaugeIcon />
                Change limit
              </Button>
            }
            title="API request limit"
            description="Applies to every API key of this tenant from the next request. The platform default is set by the operator of this deployment."
          >
            {({ close }) => <RateLimitForm tenantId={tenantId} rateLimitPerMin={rateLimitPerMin} onDone={close} />}
          </FormDialog>
        </CardAction>
      </CardHeader>
    </Card>
  )
}

function RateLimitForm({ tenantId, rateLimitPerMin, onDone }: { tenantId: string; rateLimitPerMin: number | null; onDone: () => void }) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (input: RateLimitInput) => setTenantRateLimit({ data: { tenantId, ...input } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ops', 'tenant', tenantId] })
      toast.success('Request limit saved.')
    },
  })
  const form = useAppForm({
    defaultValues: { useDefault: rateLimitPerMin === null, rateLimitPerMin: rateLimitPerMin ?? 300 } satisfies RateLimitInput,
    validationLogic: formValidation,
    validators: { onDynamic: rateLimitInput },
    onSubmit: ({ value }) => submitMutation(save, value, onDone),
  })
  return (
    <Form form={form}>
      <form.FormError error={save.error} />
      <form.AppField name="useDefault">{(field) => <field.SwitchField label="Use the platform default" />}</form.AppField>
      <form.Subscribe selector={(state) => state.values.useDefault}>
        {(useDefault) =>
          useDefault ? null : (
            <form.AppField name="rateLimitPerMin">{(field) => <field.NumberField label="Requests per minute per API key (0 = no limit)" min={0} max={100_000} />}</form.AppField>
          )
        }
      </form.Subscribe>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Saving…">Save</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}
