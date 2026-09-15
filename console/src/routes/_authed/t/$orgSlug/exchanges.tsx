import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useHydrated } from '@tanstack/react-router'
import QRCode from 'qrcode'
import { type FormEvent, useEffect, useState } from 'react'

import { RouteError } from '@/components/route-error'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { createPortalInvitation } from '@/features/portal/portal-data.functions'
import { portalConnectionsQuery, portalCredentialsQuery, portalKey, portalProofsQuery } from '@/features/portal/portal.queries'
import { ExchangeTables } from '@/features/tenant-data/panels'
import { tenantCan } from '@/lib/permissions'

export const Route = createFileRoute('/_authed/t/$orgSlug/exchanges')({
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(portalConnectionsQuery(params.orgSlug)),
      context.queryClient.ensureQueryData(portalCredentialsQuery(params.orgSlug)),
      context.queryClient.ensureQueryData(portalProofsQuery(params.orgSlug)),
    ]),
  errorComponent: RouteError,
  component: PortalExchangesPage,
})

function PortalExchangesPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const { data: connections } = useSuspenseQuery(portalConnectionsQuery(orgSlug))
  const { data: credentials } = useSuspenseQuery(portalCredentialsQuery(orgSlug))
  const { data: proofs } = useSuspenseQuery(portalProofsQuery(orgSlug))
  return (
    <div className="space-y-6">
      {tenantCan(organization.role, { exchange: ['create'] }) && <InvitationCard organizationId={organization.id} orgSlug={orgSlug} />}
      <ExchangeTables connections={connections} credentials={credentials} proofs={proofs} />
    </div>
  )
}

function InvitationCard({ organizationId, orgSlug }: { organizationId: string; orgSlug: string }) {
  const hydrated = useHydrated()
  const queryClient = useQueryClient()
  const [qr, setQr] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: (input: { multiUse: boolean; alias?: string }) => createPortalInvitation({ data: { organizationId, ...input } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'connections') }),
  })
  const invitationUrl = create.data?.invitationUrl

  useEffect(() => {
    if (!invitationUrl) return
    let cancelled = false
    void QRCode.toDataURL(invitationUrl, { margin: 1, width: 240 }).then((url) => !cancelled && setQr(url))
    return () => {
      cancelled = true
    }
  }, [invitationUrl])

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setQr(null)
    create.mutate({ multiUse: form.get('multiUse') === 'on', alias: String(form.get('alias') || '') || undefined })
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Connection invitation</CardTitle>
        <CardDescription>For testing with a wallet app. In production your backend creates invitations through the API.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-[1fr_auto]">
        <form method="post" onSubmit={onSubmit} className="space-y-3">
          {create.error && (
            <Alert variant="destructive">
              <AlertDescription>{create.error.message}</AlertDescription>
            </Alert>
          )}
          <Field className="max-w-xs">
            <FieldLabel htmlFor="alias">Label (optional)</FieldLabel>
            <Input id="alias" name="alias" maxLength={200} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="multiUse" />
            Multi-use (kiosk or web page; many wallets can connect)
          </label>
          <Button type="submit" disabled={!hydrated || create.isPending}>
            Create invitation
          </Button>
          {invitationUrl && <p className="font-mono text-xs break-all" data-testid="invitation-url">{invitationUrl}</p>}
        </form>
        {qr && <img src={qr} alt="Invitation QR code" className="size-60" data-testid="invitation-qr" />}
      </CardContent>
    </Card>
  )
}
