/**
 * Data protection UI (Phase 7 H1), shared by the operator console and the tenant portal:
 *   - "Erase personal data" on a finished exchange or a connection; operators must give a reason;
 *   - the "erased" mark next to a scrubbed record;
 *   - the retention period card, the audit log's own period (implement/22 C15) and the erasure log.
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
import { announceHeld } from '@/lib/held'
import type { Page } from '@/lib/list-search'

import { AUDIT_RETENTION_MAX_DAYS, validAuditRetentionDays } from './retention.schemas'

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

/** The audit log's own period (implement/22 C15). */
export interface AuditRetention {
  auditRetentionDays: number
  tenantSetting: number | null
  platformDefault: number
  minimumDays: number
}

const describeDays = (days: number) => (days === 0 ? 'kept until erased on request' : `${days} day${days === 1 ? '' : 's'}`)
/** 730 days reads better as "730 days (2 years)"; a period that is not whole years stays in days. */
const describeAuditDays = (days: number) => (days === 0 ? 'kept, never deleted' : days % 365 === 0 ? `${days} days (${days / 365} year${days === 365 ? '' : 's'})` : `${days} days`)

interface PeriodCardProps {
  title: string
  description: string
  /** The period in force, the organisation's own setting (null = the platform default) and that default, in days. */
  inForce: number
  tenantSetting: number | null
  platformDefault: number
  describe: (days: number) => string
  /** Whether a typed whole number may be saved. */
  valid: (days: number) => boolean
  hint: string
  saved: string
  testId: string
  save?: (days: number | null) => Promise<unknown>
  invalidateKey: QueryKey
}

/** One period in days, with an editor when `save` is given (owners, admins, operators). */
function PeriodCard({ title, description, inForce, tenantSetting, platformDefault, describe, valid, hint, saved, testId, save, invalidateKey }: PeriodCardProps) {
  const hydrated = useHydrated()
  const queryClient = useQueryClient()
  const inputId = useId()
  const [value, setValue] = useState(tenantSetting === null ? '' : String(tenantSetting))
  const mutation = useMutation({
    mutationFn: (days: number | null) => save!(days),
    onSuccess: async (result) => {
      if (announceHeld(result, queryClient)) return
      toast.success(saved)
      await queryClient.invalidateQueries({ queryKey: invalidateKey })
    },
  })
  const parsed = value.trim() === '' ? null : Number(value)
  const invalid = parsed !== null && (!Number.isInteger(parsed) || !valid(parsed))
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm" data-testid={`${testId}-in-force`}>
          In force: <strong>{describe(inForce)}</strong>
          {tenantSetting === null ? ` (the platform default)` : ` (your setting; the platform default is ${describe(platformDefault)})`}
        </p>
        {save && (
          <form
            noValidate
            method="post"
            className="flex flex-wrap items-end gap-2"
            data-testid={`${testId}-form`}
            onSubmit={(event) => {
              event.preventDefault()
              if (!invalid) mutation.mutate(parsed)
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor={inputId}>Days</Label>
              <Input id={inputId} inputMode="numeric" className="w-40" value={value} readOnly={!hydrated} aria-invalid={invalid} placeholder={`default (${platformDefault})`} onChange={(event) => setValue(event.target.value)} />
            </div>
            <Button type="submit" disabled={!hydrated || invalid || mutation.isPending}>
              {mutation.isPending && <Spinner />}
              Save
            </Button>
            <p className="basis-full text-xs text-muted-foreground">{hint}</p>
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

/** The retention period, with an editor when `save` is given (owners, admins, operators). */
export function RetentionCard({ retention, save, invalidateKey }: { retention: Retention; save?: (retentionDays: number | null) => Promise<unknown>; invalidateKey: QueryKey }) {
  return (
    <PeriodCard
      title="Retention period"
      description="How long personal data is kept after an exchange finishes: credential attribute values, disclosed proof values, webhook delivery bodies and biometric scores. After that it is erased automatically; the exchanges stay in your lists and dashboards."
      inForce={retention.retentionDays}
      tenantSetting={retention.tenantSetting}
      platformDefault={retention.platformDefault}
      describe={describeDays}
      valid={(days) => days >= 0 && days <= 3650}
      hint="Empty = the platform default. 0 = keep until erased on request. At most 3650."
      saved="Retention period saved."
      testId="retention"
      save={save}
      invalidateKey={invalidateKey}
    />
  )
}

/**
 * The audit log's period. It is a setting of its own, and a longer one: the log has to outlast the
 * data it describes, or the record that someone revealed or erased a person's data would go with it.
 */
export function AuditRetentionCard({ retention, save, invalidateKey }: { retention: AuditRetention; save?: (auditRetentionDays: number | null) => Promise<unknown>; invalidateKey: QueryKey }) {
  return (
    <PeriodCard
      title="Audit log period"
      description="How long the audit log keeps its entries about this organisation: who changed which setting, who revealed or erased personal data, and who exported a list. Older entries are deleted. This period is separate from the one above and longer on purpose: the log has to outlast the data it describes. Sign-ins are kept for the platform's period."
      inForce={retention.auditRetentionDays}
      tenantSetting={retention.tenantSetting}
      platformDefault={retention.platformDefault}
      describe={describeAuditDays}
      valid={validAuditRetentionDays}
      hint={`Empty = the platform default. 0 = keep everything. Otherwise ${retention.minimumDays} to ${AUDIT_RETENTION_MAX_DAYS} days: the log is kept for a year at least.`}
      saved="Audit log period saved."
      testId="audit-retention"
      save={save}
      invalidateKey={invalidateKey}
    />
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
