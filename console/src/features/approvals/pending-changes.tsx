/**
 * "A change to this is waiting for approval" (implement/22-console-feedback.md C19). Shown on the
 * page a held change is about, so nobody wonders why what they saved is not there, and nobody asks
 * for the same thing twice. It reads the same list as the sidebar's count.
 *
 * The list is read in the browser, never on the server. The shell hydrates before the page and starts
 * that read, so by the time the page hydrates the list can already be there, while the server's HTML
 * has no notice: rendering it then would be a hydration mismatch (found by the browser run,
 * implement/23). So the notice appears only once hydration is over.
 */
import { useQuery } from '@tanstack/react-query'
import { Link, useHydrated } from '@tanstack/react-router'
import { HourglassIcon } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'

import { type OpenChange, opsOpenChangesQuery, portalOpenChangesQuery } from './approvals.queries'

function Notice({ changes, types, to, params }: { changes: OpenChange[] | undefined; types: readonly string[]; to: '/t/$orgSlug/approvals' | '/ops/tenants/$tenantId/approvals' | '/ops/approvals'; params: Record<string, string> }) {
  const hydrated = useHydrated()
  const about = (changes ?? []).filter((change) => types.some((prefix) => change.type.startsWith(prefix)))
  if (!hydrated || about.length === 0) return null
  return (
    <Alert data-testid="pending-changes">
      <AlertDescription>
        <span className="flex items-start gap-2">
          <HourglassIcon className="mt-0.5 size-4 shrink-0 text-status-warning" aria-hidden />
          <span className="min-w-0 space-y-1">
            <span className="block font-medium text-foreground">{about.length === 1 ? 'A change here is waiting for a second person' : `${about.length} changes here are waiting for a second person`}</span>
            <span className="block">
              {about.map((change) => (
                <span key={change.id} className="block">
                  {change.summary}, asked by {change.mine ? 'you' : (change.requestedByLabel ?? 'someone')}
                  {change.status === 'approved' ? (change.mine ? ': approved, apply it from Approvals.' : ': approved, not applied yet.') : '.'}
                </span>
              ))}
            </span>
            <Link to={to} params={params} className="underline underline-offset-4">
              Open Approvals
            </Link>
          </span>
        </span>
      </AlertDescription>
    </Alert>
  )
}

/** On an organization's page. `types`: prefixes of the kinds of change this page makes (`webhook.`). */
export function PortalPendingChanges({ orgSlug, types }: { orgSlug: string; types: readonly string[] }) {
  const { data } = useQuery(portalOpenChangesQuery(orgSlug))
  return <Notice changes={data?.items} types={types} to="/t/$orgSlug/approvals" params={{ orgSlug }} />
}

/** On an operator's page of one tenant, or (without a tenant) of the operator area. */
export function OpsPendingChanges({ tenantId, types }: { tenantId?: string; types: readonly string[] }) {
  const { data } = useQuery(opsOpenChangesQuery(tenantId))
  return tenantId ? <Notice changes={data?.items} types={types} to="/ops/tenants/$tenantId/approvals" params={{ tenantId }} /> : <Notice changes={data?.items} types={types} to="/ops/approvals" params={{}} />
}
