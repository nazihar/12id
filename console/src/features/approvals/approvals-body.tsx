/**
 * The Approvals page (implement/22-console-feedback.md C19), shared by the organization, by an
 * operator's view of a tenant and by the operator area: whether sensitive changes wait for a second
 * person, what waits now, and what was decided. Every action goes through callbacks, so the same page
 * runs over the portal's and the operators' server functions.
 */
import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { BanIcon, CheckIcon, CircleCheckIcon, CircleOffIcon, FileSearchIcon, PlayIcon, XIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { PageHeader } from '@/components/page-header'
import { RowAction, RowActions } from '@/components/row-action'
import { SecretOnceDialog } from '@/components/secret-once-dialog'
import { StateBadge } from '@/components/state-badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { formatDateTime } from '@/lib/format'
import { announceHeld } from '@/lib/held'
import type { Page } from '@/lib/list-search'

import type { ApprovalsOverview, ChangeRequestRow } from './approvals.queries'
import { type AppliedResult, type ApprovalSearch, type ApprovalTab, statusText } from './approvals.schemas'

export type ApprovalsScope = 'organization' | 'tenant' | 'operators'

export interface ApprovalsActions {
  /** Absent: the viewer cannot switch the requirement (a member, an auditor, or the operator area, where it is a server setting). */
  setRequired?: (required: boolean) => Promise<unknown>
  /** Absent: the viewer reads and decides nothing. */
  decide?: (id: string, action: 'approve' | 'reject', reason?: string) => Promise<unknown>
  /** For the viewer's own requests. Absent: the viewer cannot have asked for anything (an auditor). */
  cancel?: (id: string) => Promise<unknown>
  apply?: (id: string) => Promise<AppliedResult>
}

interface ApprovalsBodyProps {
  scope: ApprovalsScope
  overview: ApprovalsOverview
  data: Page<ChangeRequestRow>
  search: ApprovalSearch
  onSearch: (patch: Partial<ApprovalSearch>) => void
  fetching: boolean
  actions: ApprovalsActions
  /** Everything this page shows is refreshed after an action. */
  invalidateKey: QueryKey
}

const WHO: Record<ApprovalsScope, { title: string; description: string; people: string }> = {
  organization: {
    title: 'Approvals',
    description: 'Changes that open access, send data somewhere else, weaken a check or cannot be undone can wait for a second person. Whoever asks for a change cannot approve it.',
    people: 'owners and admins',
  },
  tenant: {
    title: 'Approvals',
    description: "This tenant's changes that wait for a second person. An operator can decide the ones an operator could make here: its API keys and its two retention periods.",
    people: 'owners and admins of the organization',
  },
  operators: {
    title: 'Approvals',
    description: 'Changes to operator accounts that wait for a second operator: adding an account, changing a role, unbanning. Banning, signing out and deleting never wait.',
    people: 'operators',
  },
}

const SECRET_TEXT = {
  api_key: { title: 'API key created', description: 'Copy it now and store it in your secret manager. It is shown only once; the platform keeps only a hash.' },
  webhook_secret: { title: 'Webhook signing secret', description: 'Copy it now into your receiver. It is shown only once.' },
} as const

const column = createColumnHelper<DataTableFeatures, ChangeRequestRow>()

export function ApprovalsBody({ scope, overview, data, search, onSearch, fetching, actions, invalidateKey }: ApprovalsBodyProps) {
  const queryClient = useQueryClient()
  const [viewing, setViewing] = useState<ChangeRequestRow | null>(null)
  const [secret, setSecret] = useState<AppliedResult['secret']>(null)
  const tab: ApprovalTab = search.tab ?? 'waiting'
  // A decided or applied request changes what other pages show (a webhook, a period, the members), and
  // those pages cache what they read: everything is read again, not only this page's lists.
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: invalidateKey })
    void queryClient.invalidateQueries()
  }

  const decide = useMutation({
    mutationFn: (input: { id: string; action: 'approve' | 'reject'; reason?: string }) => actions.decide!(input.id, input.action, input.reason),
    onSuccess: async (_, input) => {
      toast.success(input.action === 'approve' ? 'Approved.' : 'Rejected.')
      await refresh()
    },
  })
  const cancel = useMutation({
    mutationFn: (id: string) => actions.cancel!(id),
    onSuccess: async () => {
      toast.success('Request cancelled.')
      await refresh()
    },
  })
  const apply = useMutation({
    mutationFn: (id: string) => actions.apply!(id),
    onSuccess: async (result) => {
      if (result.error) toast.error(`It could not be applied: ${result.error}`)
      else if (result.secret) setSecret(result.secret)
      else toast.success('Applied.')
      await refresh()
    },
  })

  const columns = column.columns([
    column.accessor('requestedAt', { header: 'Asked', cell: ({ getValue }) => formatDateTime(getValue()) }),
    column.accessor('summary', {
      header: 'Change',
      cell: ({ row }) => (
        <span className="block min-w-0">
          <span className="block font-medium">{row.original.label}</span>
          <span className="block max-w-xl text-xs whitespace-normal text-muted-foreground">{row.original.summary}</span>
        </span>
      ),
    }),
    column.accessor((row) => row.requestedByLabel ?? row.requestedBy, { id: 'by', header: 'Asked by', cell: ({ row, getValue }) => `${getValue()}${row.original.mine ? ' (you)' : ''}` }),
    column.accessor('status', {
      header: 'State',
      cell: ({ row }) => (
        <span className="block">
          <StateBadge state={row.original.status} />
          <span className="mt-0.5 block max-w-xs text-xs whitespace-normal text-muted-foreground">{row.original.status === 'failed' && row.original.applyError ? row.original.applyError : statusText(row.original)}</span>
        </span>
      ),
    }),
    tab === 'waiting'
      ? column.accessor('expiresAt', { header: 'Expires', cell: ({ getValue }) => formatDateTime(getValue()) })
      : column.accessor((row) => row.decidedByLabel ?? row.decidedBy ?? '', { id: 'decidedBy', header: 'Decided by', cell: ({ row, getValue }) => (getValue() ? `${getValue()} · ${formatDateTime(row.original.decidedAt)}` : '—') }),
    column.display({
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const request = row.original
        // An operator sees every request of a tenant and may decide the few an operator could make.
        const canDecide = Boolean(actions.decide) && request.decidable && request.status === 'pending' && !request.mine
        const open = request.status === 'pending' || request.status === 'approved'
        return (
          <RowActions>
            <RowAction label="Details" icon={FileSearchIcon} onClick={() => setViewing(request)} />
            {canDecide && (
              <RowAction
                label="Approve"
                icon={CheckIcon}
                confirm={{
                  title: `Approve: ${request.label}?`,
                  description: `${request.summary}. Asked by ${request.requestedByLabel ?? request.requestedBy}. ${request.apply === 'by_requester' ? 'Once approved, they apply it themselves.' : 'It takes effect at once.'}`,
                  confirmLabel: 'Approve',
                  pendingLabel: 'Approving…',
                  onConfirm: () => decide.mutateAsync({ id: request.id, action: 'approve' }),
                }}
              />
            )}
            {canDecide && <RejectAction request={request} onReject={(reason) => decide.mutateAsync({ id: request.id, action: 'reject', reason })} />}
            {actions.apply && request.mine && request.status === 'approved' && (
              <RowAction
                label="Apply"
                icon={PlayIcon}
                confirm={{
                  title: `Apply: ${request.label}?`,
                  description: `${request.summary}. Approved by ${request.decidedByLabel ?? request.decidedBy ?? 'a second person'}. The change is made now.`,
                  confirmLabel: 'Apply',
                  pendingLabel: 'Applying…',
                  onConfirm: () => apply.mutateAsync(request.id),
                }}
              />
            )}
            {actions.cancel && request.mine && open && (
              <RowAction
                label="Cancel request"
                icon={BanIcon}
                confirm={{
                  title: 'Cancel this request?',
                  description: `${request.summary}. Nothing is changed; ask again if you still need it.`,
                  confirmLabel: 'Cancel request',
                  destructive: true,
                  onConfirm: () => cancel.mutateAsync(request.id),
                }}
              />
            )}
          </RowActions>
        )
      },
    }),
  ])

  return (
    <div className="space-y-6">
      <PageHeader title={WHO[scope].title} description={WHO[scope].description} />
      <RequirementCard scope={scope} overview={overview} setRequired={actions.setRequired} onChanged={refresh} />

      <section className="space-y-3">
        <Tabs value={tab} onValueChange={(next) => onSearch({ tab: next === 'waiting' ? undefined : 'history', page: undefined })}>
          <TabsList>
            <TabsTrigger value="waiting">Waiting</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
        </Tabs>
        <DataTable
          columns={columns}
          data={data.items}
          paging={{ page: data.page, pageSize: data.pageSize, total: data.total, onChange: (next) => onSearch({ page: next.page && next.page > 1 ? next.page : undefined, pageSize: next.pageSize }) }}
          emptyMessage={tab === 'waiting' ? 'Nothing is waiting for a second person.' : 'No request has been decided yet.'}
          testId="change-requests"
          fetching={fetching}
        />
      </section>

      <RequestDialog request={viewing} onClose={() => setViewing(null)} />
      <SecretOnceDialog secret={secret?.value ?? null} title={SECRET_TEXT[secret?.kind ?? 'api_key'].title} description={SECRET_TEXT[secret?.kind ?? 'api_key'].description} onClose={() => setSecret(null)} />
    </div>
  )
}

/** Whether a second person is required, the switch for those who may use it, and the list of what waits. */
function RequirementCard({ scope, overview, setRequired, onChanged }: { scope: ApprovalsScope; overview: ApprovalsOverview; setRequired?: (required: boolean) => Promise<unknown>; onChanged: () => Promise<unknown> }) {
  const queryClient = useQueryClient()
  const { required, approvers, enough, types } = overview
  const Icon = required ? CircleCheckIcon : CircleOffIcon
  const people = WHO[scope].people

  return (
    <Card size="sm" data-testid="approval-requirement" data-required={required}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className={`size-4 ${required ? 'text-status-good' : 'text-muted-foreground'}`} aria-hidden />
          {required ? 'A second person is required' : 'A second person is not required'}
        </CardTitle>
        <CardDescription>
          {scope === 'operators'
            ? `Set on the server (OPERATOR_APPROVALS) and changed with a deploy. ${approvers} operator${approvers === 1 ? '' : 's'} can sign in.`
            : required
              ? `The changes listed below wait until someone other than the person who asked approves them. ${approvers} of the ${people} can decide.`
              : `Every change takes effect at once. ${approvers} of the ${people} could decide a request${enough ? '.' : '; it takes two before this can be switched on, because nobody approves their own request.'}`}
        </CardDescription>
        {setRequired && (
          <CardAction>
            {required ? (
              <ConfirmDialog
                trigger={<Button size="sm" variant="outline">Stop requiring</Button>}
                title="Stop requiring a second person?"
                description="This is itself a change that waits: someone else has to approve it before the requirement ends."
                confirmLabel="Ask to stop"
                onConfirm={async () => {
                  const result = await setRequired(false)
                  if (!announceHeld(result, queryClient)) toast.success('A second person is no longer required.')
                  await onChanged()
                }}
              />
            ) : (
              <ConfirmDialog
                trigger={
                  <Button size="sm" disabled={!enough}>
                    Require a second person
                  </Button>
                }
                title="Require a second person?"
                description="From now on the changes listed on this page wait for approval by someone other than the person who asked. Revoking a key, removing a member and other changes that only close access never wait. Switching this off again will itself need approval."
                confirmLabel="Require a second person"
                onConfirm={async () => {
                  await setRequired(true)
                  toast.success('A second person is now required.')
                  await onChanged()
                }}
              />
            )}
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">What waits for a second person ({types.length})</summary>
          <ul className="mt-2 grid gap-x-8 gap-y-1 sm:grid-cols-2" data-testid="approval-types">
            {types.map((type) => (
              <li key={type.id}>
                {type.label}
                {type.apply === 'by_requester' && <span className="text-muted-foreground"> · applied by the person who asked</span>}
              </li>
            ))}
          </ul>
        </details>
      </CardContent>
    </Card>
  )
}

/** Rejecting needs a reason: the person who asked reads it. */
function RejectAction({ request, onReject }: { request: ChangeRequestRow; onReject: (reason: string) => Promise<unknown> }) {
  const reasonId = useId()
  const [reason, setReason] = useState('')
  return (
    <RowAction
      label="Reject"
      icon={XIcon}
      confirm={{
        title: `Reject: ${request.label}?`,
        description: `${request.summary}. Asked by ${request.requestedByLabel ?? request.requestedBy}. Nothing is changed.`,
        confirmLabel: 'Reject',
        pendingLabel: 'Rejecting…',
        destructive: true,
        onConfirm: async () => {
          const trimmed = reason.trim()
          if (trimmed.length < 3) throw new Error('Say why: the person who asked will read it.')
          await onReject(trimmed)
          setReason('')
        },
        children: (
          <div className="grid gap-1.5">
            <Label htmlFor={reasonId}>Reason (required)</Label>
            <Textarea id={reasonId} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="What should be different" />
          </div>
        ),
      }}
    />
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function RequestDialog({ request, onClose }: { request: ChangeRequestRow | null; onClose: () => void }) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto overscroll-contain sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{request?.label}</DialogTitle>
          <DialogDescription>{request?.summary}</DialogDescription>
        </DialogHeader>
        {request && (
          <div className="space-y-4 text-sm" data-testid="change-request">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              <Fact label="State">{request.status === 'failed' && request.applyError ? `${statusText(request)}: ${request.applyError}` : statusText(request)}</Fact>
              <Fact label="Asked by">
                {request.requestedByLabel ?? request.requestedBy} ({request.requestedByRole}), {formatDateTime(request.requestedAt)}
              </Fact>
              {request.decidedAt && (
                <Fact label={request.status === 'rejected' ? 'Rejected by' : 'Approved by'}>
                  {request.decidedByLabel ?? request.decidedBy} ({request.decidedByRole}), {formatDateTime(request.decidedAt)}
                </Fact>
              )}
              {request.decisionReason && <Fact label="Reason">{request.decisionReason}</Fact>}
              {request.appliedAt && request.status === 'applied' && <Fact label="Applied">{formatDateTime(request.appliedAt)}</Fact>}
              {(request.status === 'pending' || request.status === 'approved') && <Fact label="Expires">{formatDateTime(request.expiresAt)}</Fact>}
            </dl>
            {request.before && (
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">In force when it was asked</h3>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs" data-testid="change-before">
                  {request.before}
                </pre>
              </div>
            )}
            {request.change && (
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">Asked for</h3>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs" data-testid="change-asked">
                  {request.change}
                </pre>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
