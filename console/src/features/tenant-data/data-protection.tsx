/**
 * Data protection UI (Phase 7 H1), shared by the operator console and the tenant portal:
 *   - "Erase personal data" on a finished exchange or a connection; operators must give a reason;
 *   - the "erased" mark next to a scrubbed record;
 *   - the retention period card and the erasure log.
 * Every action goes through callbacks, so the same UI runs over operator and portal server functions.
 */
import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query'
import { useHydrated } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { EraserIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { PageHeader } from '@/components/page-header'
import { RowAction } from '@/components/row-action'
import { Spinner } from '@/components/spinner'
import { StateBadge } from '@/components/state-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatDateTime } from '@/lib/format'
import type { Page } from '@/lib/list-search'

export type EraseKind = 'connection' | 'credential' | 'proof'

/** Exchanges in these states are finished; only they can be erased (platform-api answers 409 otherwise). */
export const FINISHED_STATES = ['done', 'abandoned', 'declined'] as const
export const isFinished = (state: string) => (FINISHED_STATES as readonly string[]).includes(state)

export interface Eraser {
  erase: (kind: EraseKind, id: string, reason: string | undefined) => Promise<unknown>
  /** Operators act on the tenant's request and must say why. */
  reasonRequired: boolean
  invalidateKey: QueryKey
}

const NOUN: Record<EraseKind, string> = { connection: 'connection', credential: 'credential exchange', proof: 'proof exchange' }
const WHAT: Record<EraseKind, string> = {
  connection: "the holder's label, and the personal data of every credential and proof exchange on this connection. The connection is closed: the holder can no longer reach you through it",
  credential: 'the attribute values of this credential exchange',
  proof: 'the disclosed values of this proof exchange',
}

/** The state badge, plus an "erased" mark when the record's personal data is gone. */
export function StateWithErasure({ state, erasedAt }: { state: string; erasedAt: string | null }) {
  return (
    <span className="flex items-center gap-1.5">
      <StateBadge state={state} />
      {erasedAt && (
        <Badge variant="ghost" title={`Personal data erased ${formatDateTime(erasedAt)}`} data-testid="erased-badge">
          erased
        </Badge>
      )}
    </span>
  )
}

export function EraseAction({ kind, id, eraser }: { kind: EraseKind; id: string; eraser: Eraser }) {
  const queryClient = useQueryClient()
  const reasonId = useId()
  const [reason, setReason] = useState('')
  const mutation = useMutation({
    mutationFn: () => {
      const trimmed = reason.trim()
      if (eraser.reasonRequired && trimmed.length < 3) throw new Error('Give the reason: which request from the organisation this answers.')
      return eraser.erase(kind, id, trimmed || undefined)
    },
    onSuccess: async () => {
      toast.success(`Personal data of the ${NOUN[kind]} erased.`)
      setReason('')
      await queryClient.invalidateQueries({ queryKey: eraser.invalidateKey })
    },
  })
  return (
    <RowAction
      label="Erase personal data"
      icon={EraserIcon}
      confirm={{
        title: `Erase the personal data of this ${NOUN[kind]}?`,
        description: `Removes ${WHAT[kind]}, everywhere 12iD keeps it: the agent's records, webhook delivery bodies and biometric scores. The record itself stays, with its ids, state and dates. This cannot be undone. The credential in the holder's wallet is not affected.`,
        confirmLabel: 'Erase',
        pendingLabel: 'Erasing…',
        destructive: true,
        onConfirm: () => mutation.mutateAsync(),
        children: (
          <div className="grid gap-1.5">
            <Label htmlFor={reasonId}>{eraser.reasonRequired ? 'Reason (required)' : 'Reason (optional)'}</Label>
            <Textarea id={reasonId} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder={eraser.reasonRequired ? 'Which request from the organisation this answers, e.g. a ticket number' : 'e.g. erasure request from the holder'} />
            <p className="text-xs text-muted-foreground">Recorded in the erasure log and the audit log.</p>
          </div>
        ),
      }}
    />
  )
}

// --- retention ----------------------------------------------------------------------------

export interface Retention {
  retentionDays: number
  tenantSetting: number | null
  platformDefault: number
}

const describeDays = (days: number) => (days === 0 ? 'kept until erased on request' : `${days} day${days === 1 ? '' : 's'}`)

/** The retention period, with an editor when `save` is given (owners, admins, operators). */
export function RetentionCard({ retention, save, invalidateKey }: { retention: Retention; save?: (retentionDays: number | null) => Promise<unknown>; invalidateKey: QueryKey }) {
  const hydrated = useHydrated()
  const queryClient = useQueryClient()
  const inputId = useId()
  const [value, setValue] = useState(retention.tenantSetting === null ? '' : String(retention.tenantSetting))
  const mutation = useMutation({
    mutationFn: (days: number | null) => save!(days),
    onSuccess: async () => {
      toast.success('Retention period saved.')
      await queryClient.invalidateQueries({ queryKey: invalidateKey })
    },
  })
  const parsed = value.trim() === '' ? null : Number(value)
  const invalid = parsed !== null && (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Retention period</CardTitle>
        <CardDescription>
          How long personal data is kept after an exchange finishes: credential attribute values, disclosed proof values, webhook delivery bodies and biometric scores. After that it is erased automatically; the exchanges stay in your lists and dashboards.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm" data-testid="retention-in-force">
          In force: <strong>{describeDays(retention.retentionDays)}</strong>
          {retention.tenantSetting === null ? ` (the platform default)` : ` (your setting; the platform default is ${describeDays(retention.platformDefault)})`}
        </p>
        {save && (
          <form
            noValidate
            method="post"
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!invalid) mutation.mutate(parsed)
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor={inputId}>Days</Label>
              <Input id={inputId} inputMode="numeric" className="w-40" value={value} readOnly={!hydrated} aria-invalid={invalid} placeholder={`default (${retention.platformDefault})`} onChange={(event) => setValue(event.target.value)} />
            </div>
            <Button type="submit" disabled={!hydrated || invalid || mutation.isPending}>
              {mutation.isPending && <Spinner />}
              Save
            </Button>
            <p className="basis-full text-xs text-muted-foreground">Empty = the platform default. 0 = keep until erased on request. At most 3650.</p>
          </form>
        )}
        {mutation.error && (
          <Alert variant="destructive">
            <AlertDescription>{mutation.error.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

// --- erasure log --------------------------------------------------------------------------

export interface ErasureRow {
  id: number
  recordType: EraseKind
  recordId: string
  via: string
  actor: string
  role: string | null
  reason: string | null
  at: string
}

const erasureColumn = createColumnHelper<DataTableFeatures, ErasureRow>()
const erasureColumns = erasureColumn.columns([
  erasureColumn.accessor('at', { header: 'When', cell: ({ getValue }) => formatDateTime(getValue()) }),
  erasureColumn.accessor('recordType', { header: 'Record', cell: ({ getValue }) => NOUN[getValue()] }),
  erasureColumn.accessor('recordId', { header: 'Id', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span> }),
  erasureColumn.accessor((row) => (row.via === 'api_key' ? 'API key' : (row.role ?? 'console')), { id: 'by', header: 'By', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
  erasureColumn.accessor('reason', { header: 'Reason', cell: ({ getValue }) => getValue() ?? '' }),
])

export function ErasureLog({ data, onPage }: { data: Page<ErasureRow>; onPage: (page: number) => void }) {
  return (
    <section className="space-y-4">
      <PageHeader level={2} title="Erasure log" description="Every erasure made on request, newest first, with who asked and why. Automatic erasures by the retention period are not listed; the exchange shows when it happened." />
      <DataTable
        columns={erasureColumns}
        data={data.items}
        paging={{ page: data.page, pageSize: data.pageSize, total: data.total, onChange: (next) => onPage(next.page ?? 1) }}
        emptyMessage="No erasures yet."
        testId="erasures-table"
      />
    </section>
  )
}
