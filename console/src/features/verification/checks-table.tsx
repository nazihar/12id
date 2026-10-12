/**
 * The face-checks table (implement/22-console-feedback.md C10): one row per gated exchange, with the
 * outcome, the last scores against the minimums that applied, and the way to the full log. Shared by
 * the Verification page (every check of the tenant) and the customer page (one connection's checks);
 * the caller owns the search box and the filters, since the two pages filter differently.
 */
import { createColumnHelper } from '@tanstack/react-table'
import { ScanFaceIcon, UserSearchIcon } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import { DataTable, type DataTablePaging } from '@/components/data-table/data-table'
import { ExportMenu, type Exporter } from '@/components/data-table/export-menu'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { RowAction, RowActions } from '@/components/row-action'
import { StateBadge } from '@/components/state-badge'
import { type BiometricLogLoader, BiometricLogDialog, type CustomerOpener, score } from '@/features/tenant-data/panels'
import { formatDateTime } from '@/lib/format'

import type { CheckRow } from './verification.queries'
import { KIND_LABELS, reasonLabel } from './verification.schemas'

const column = createColumnHelper<DataTableFeatures, CheckRow>()

function columnsWith(onLog: (row: CheckRow) => void, onOpenCustomer?: CustomerOpener) {
  return column.columns([
    column.accessor('createdAt', { header: 'Started', cell: ({ getValue }) => formatDateTime(getValue()) }),
    column.accessor('recordType', { header: 'For', cell: ({ getValue }) => KIND_LABELS[getValue()] }),
    column.accessor('externalId', { header: 'External id', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue() ?? '—'}</span> }),
    column.accessor((row) => row.biometric.status, { id: 'status', header: 'Outcome', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
    column.accessor((row) => row.biometric.attempts, { id: 'attempts', header: 'Attempts' }),
    column.accessor((row) => row.biometric.livenessScore, { id: 'liveness', header: 'Liveness', cell: ({ row }) => <span className="font-mono text-xs">{score(row.original.biometric.livenessScore, row.original.thresholds.minLivenessScore)}</span> }),
    column.accessor((row) => row.biometric.matchScore, { id: 'match', header: 'Match', cell: ({ row }) => <span className="font-mono text-xs">{score(row.original.biometric.matchScore, row.original.thresholds.minMatchScore)}</span> }),
    // The last attempt's reason, or why the check ended without one. A pass needs no reason.
    column.accessor((row) => (row.biometric.status === 'passed' || !row.biometric.reason ? '' : reasonLabel(row.biometric.reason)), { id: 'reason', header: 'Reason' }),
    column.display({
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const connectionId = onOpenCustomer ? row.original.connectionId : null
        return (
          <RowActions>
            {connectionId && <RowAction label="Customer activity" icon={UserSearchIcon} onClick={() => onOpenCustomer?.(connectionId)} />}
            <RowAction label="Biometric log" icon={ScanFaceIcon} onClick={() => onLog(row.original)} />
          </RowActions>
        )
      },
    }),
  ])
}

export function FaceChecksTable({
  rows,
  paging,
  search,
  toolbar,
  onReset,
  fetching,
  emptyMessage,
  loadBiometricLog,
  onOpenCustomer,
  onExport,
}: {
  rows: CheckRow[]
  paging: DataTablePaging
  search?: { value?: string; placeholder: string; onChange: (value: string | undefined) => void }
  toolbar?: ReactNode
  onReset?: () => void
  fetching?: boolean
  emptyMessage: string
  loadBiometricLog: BiometricLogLoader
  /** Adds the way to the customer page of a check's connection; omit on that page itself. */
  onOpenCustomer?: CustomerOpener
  /** The checks as a file, under the filters shown; omit when the viewer may not export. */
  onExport?: Exporter
}) {
  const [viewing, setViewing] = useState<{ kind: 'credential' | 'proof'; id: string } | null>(null)
  const columns = useMemo(() => columnsWith((row) => setViewing({ kind: row.recordType, id: row.recordId }), onOpenCustomer), [onOpenCustomer])
  return (
    <>
      <DataTable columns={columns} data={rows} paging={paging} search={search} toolbar={toolbar} onReset={onReset} actions={onExport && <ExportMenu onExport={onExport} />} fetching={fetching} emptyMessage={emptyMessage} testId="checks-table" />
      <BiometricLogDialog target={viewing} load={loadBiometricLog} onClose={() => setViewing(null)} />
    </>
  )
}
