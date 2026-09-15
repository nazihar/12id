import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useHydrated } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'

import { RouteError } from '@/components/route-error'
import { SecretOnceDialog } from '@/components/secret-once-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { deletePortalWebhook, getPortalDelivery, retryPortalDelivery, rotatePortalWebhookSecret, setPortalWebhook } from '@/features/portal/portal-data.functions'
import { portalDeliveriesQuery, portalKey, portalWebhookQuery } from '@/features/portal/portal.queries'
import { DeliveriesPanel } from '@/features/tenant-data/panels'
import { WEBHOOK_EVENT_TYPES, type WebhookEndpoint, type WebhookEventType } from '@/features/tenant-data/types'
import { formatDateTime } from '@/lib/format'
import { tenantCan } from '@/lib/permissions'

export const Route = createFileRoute('/_authed/t/$orgSlug/webhooks')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(portalWebhookQuery(params.orgSlug)),
  errorComponent: RouteError,
  component: PortalWebhooksPage,
})

function PortalWebhooksPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const { data: endpoint } = useSuspenseQuery(portalWebhookQuery(orgSlug))
  const canUpdate = tenantCan(organization.role, { webhook: ['update'] })
  const canRotate = tenantCan(organization.role, { webhook: ['rotate'] })
  const canRetry = tenantCan(organization.role, { webhook: ['retry'] })
  const organizationId = organization.id

  return (
    <div className="space-y-6">
      <EndpointCard endpoint={endpoint} organizationId={organizationId} orgSlug={orgSlug} canUpdate={canUpdate} canRotate={canRotate} />
      <DeliveriesPanel
        queryFor={(status) => portalDeliveriesQuery(orgSlug, status)}
        invalidateKey={portalKey(orgSlug, 'webhook-deliveries')}
        loadBody={(deliveryId) => getPortalDelivery({ data: { deliveryId } })}
        retryDelivery={canRetry ? (deliveryId) => retryPortalDelivery({ data: { organizationId, deliveryId } }) : undefined}
      />
    </div>
  )
}

function EndpointCard({ endpoint, organizationId, orgSlug, canUpdate, canRotate }: { endpoint: WebhookEndpoint | null; organizationId: string; orgSlug: string; canUpdate: boolean; canRotate: boolean }) {
  const hydrated = useHydrated()
  const queryClient = useQueryClient()
  const [secret, setSecret] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const refresh = () => queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'webhook') })

  const save = useMutation({
    mutationFn: (input: { url: string; events?: WebhookEventType[] }) => setPortalWebhook({ data: { organizationId, ...input } }),
    onSuccess: async (saved) => {
      if (saved.secret) setSecret(saved.secret)
      else toast.success('Webhook endpoint updated.')
      await refresh()
    },
  })
  const rotate = useMutation({
    mutationFn: () => rotatePortalWebhookSecret({ data: { organizationId } }),
    onSuccess: (rotated) => setSecret(rotated.secret),
    onError: (error) => toast.error(error.message),
  })
  const remove = useMutation({
    mutationFn: () => deletePortalWebhook({ data: { organizationId } }),
    onSuccess: async () => {
      toast.success('Webhook endpoint removed. Events are no longer delivered.')
      setConfirmRemove(false)
      await refresh()
    },
    onError: (error) => toast.error(error.message),
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const events = WEBHOOK_EVENT_TYPES.filter((type) => form.get(`event-${type}`) === 'on')
    save.mutate({ url: String(form.get('url')).trim(), events: events.length === 0 || events.length === WEBHOOK_EVENT_TYPES.length ? undefined : events })
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Webhook endpoint</CardTitle>
        <CardDescription>
          Events are POSTed as signed JSON (<code>X-12id-Signature</code>, HMAC-SHA256 with your secret). Answer 2xx within 10 seconds; failures are retried with backoff for about a day.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {endpoint && (
          <p className="text-sm text-muted-foreground">
            Current: <span className="font-mono text-xs break-all text-foreground">{endpoint.url}</span> · {endpoint.events?.join(', ') ?? 'all events'} · updated {formatDateTime(endpoint.updatedAt)}
          </p>
        )}
        {canUpdate ? (
          <form method="post" onSubmit={onSubmit}>
            <FieldGroup>
              {save.error && (
                <Alert variant="destructive">
                  <AlertDescription>{save.error.message}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="webhook-url">HTTPS URL</FieldLabel>
                <Input id="webhook-url" name="url" type="url" defaultValue={endpoint?.url} placeholder="https://backend.example.com/12id/webhooks" required />
              </Field>
              <Field>
                <FieldLabel>Events</FieldLabel>
                <div className="flex flex-wrap gap-3">
                  {WEBHOOK_EVENT_TYPES.map((type) => (
                    <label key={type} className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" name={`event-${type}`} defaultChecked={!endpoint?.events || endpoint.events.includes(type)} />
                      <span className="font-mono text-xs">{type}</span>
                    </label>
                  ))}
                </div>
                <FieldDescription>wallet.sync_requested asks your backend to push its app so the wallet collects waiting messages.</FieldDescription>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!hydrated || save.isPending}>
                  {endpoint ? 'Save endpoint' : 'Create endpoint'}
                </Button>
                {endpoint && canRotate && (
                  <Button type="button" variant="outline" onClick={() => rotate.mutate()} disabled={!hydrated || rotate.isPending}>
                    Rotate signing secret
                  </Button>
                )}
                {endpoint &&
                  (confirmRemove ? (
                    <>
                      <Button type="button" variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
                        Confirm remove
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button type="button" variant="ghost" onClick={() => setConfirmRemove(true)} disabled={!hydrated}>
                      Remove endpoint
                    </Button>
                  ))}
              </div>
            </FieldGroup>
          </form>
        ) : (
          !endpoint && <p className="text-sm text-muted-foreground">No webhook endpoint configured.</p>
        )}
      </CardContent>
      <SecretOnceDialog
        secret={secret}
        title="Webhook signing secret"
        description="Store it in your backend to verify signatures. It is shown only once; rotate it if it is lost. The previous secret stops working now."
        onClose={() => setSecret(null)}
      />
    </Card>
  )
}
