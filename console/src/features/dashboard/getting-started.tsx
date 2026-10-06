/**
 * The portal's first-run checklist (Phase 4 C8): the four things a tenant needs before its backend
 * can issue anything, each linking to the page that does it. Hidden once every step is done.
 */
import { Link, type LinkProps } from '@tanstack/react-router'
import { CircleCheckIcon, CircleIcon } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export interface GettingStartedState {
  schemas: number | null
  credentialDefinitions: number | null
  apiKeys: number
  webhookConfigured: boolean
  connections: number
}

export interface GettingStartedStep {
  key: 'schema' | 'credential-definition' | 'api-key' | 'webhook' | 'connection'
  label: string
  detail: string
  done: boolean
  /** null while the catalogue is still loading, so the step is neither ticked nor pushed. */
  known: boolean
}

export function gettingStartedSteps(state: GettingStartedState): GettingStartedStep[] {
  return [
    { key: 'schema', label: 'Publish a schema', detail: 'The attribute list of your credential; expiresOn (the expiry date) is added for you.', done: (state.schemas ?? 0) > 0, known: state.schemas !== null },
    { key: 'credential-definition', label: 'Publish a credential definition', detail: 'Your signing keys for that schema on the ledger.', done: (state.credentialDefinitions ?? 0) > 0, known: state.credentialDefinitions !== null },
    { key: 'api-key', label: 'Create an API key', detail: 'Your backend calls the platform with it; shown once.', done: state.apiKeys > 0, known: true },
    { key: 'webhook', label: 'Configure the webhook', detail: 'Where exchange events and wallet wake-ups are delivered.', done: state.webhookConfigured, known: true },
    { key: 'connection', label: 'Connect a first wallet', detail: 'Create an invitation and open it in the sample app.', done: state.connections > 0, known: true },
  ]
}

export function isGettingStartedComplete(steps: GettingStartedStep[]) {
  return steps.every((step) => step.known && step.done)
}

const PAGES = {
  schema: '/t/$orgSlug/catalogue',
  'credential-definition': '/t/$orgSlug/catalogue',
  'api-key': '/t/$orgSlug/api-keys',
  webhook: '/t/$orgSlug/webhooks',
  connection: '/t/$orgSlug/exchanges',
} as const satisfies Record<GettingStartedStep['key'], LinkProps['to']>

export function GettingStarted({ steps, orgSlug }: { steps: GettingStartedStep[]; orgSlug: string }) {
  const done = steps.filter((step) => step.done).length
  return (
    <Card size="sm" data-testid="getting-started">
      <CardHeader>
        <CardTitle>Getting started</CardTitle>
        <CardDescription>
          {done} of {steps.length} steps done. Everything here can also be done by your backend through the API.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {steps.map((step) => (
            <li key={step.key} className="flex gap-2">
              {step.done ? <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-status-good" aria-label="done" /> : <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="to do" />}
              <span className="min-w-0">
                <Link to={PAGES[step.key]} params={{ orgSlug }} className="block text-sm font-medium hover:underline">
                  {step.label}
                </Link>
                <span className="block text-xs text-muted-foreground">{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
