/**
 * What an export contains (implement/22-console-feedback.md C12): for each exportable list, its
 * columns and how a row of platform-api's list becomes a row of the file. Client-safe and pure.
 *
 * The columns are the list's own columns and identifiers. An export never carries credential
 * attribute values, disclosed values or webhook bodies: they are personal data the lists do not show
 * either, and a file leaves the console's access control behind. The server functions build the rows
 * from these definitions, so nothing else of a record reaches the browser through an export.
 *
 * Every cell has a type. References and ids are `text`, so a spreadsheet keeps `00123` and a
 * sixteen-digit account reference as written; times are `datetime` (ISO strings here, UTC).
 */
import type { listAuditLog } from '@/features/ops/ops.functions'
import { auditAction, auditResult } from '@/features/ops/audit-events'
import type { ConnectionRow, CredentialRow, DeliveryRow, ProofRow, WalletRow } from '@/features/tenant-data/types'
import type { CheckRow } from '@/features/verification/verification.queries'
import { KIND_LABELS, reasonLabel } from '@/features/verification/verification.schemas'

export const EXPORT_MAX_ROWS = 10_000
export const EXPORT_FORMATS = ['xlsx', 'csv'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export type ExportCell = string | number | null
export interface ExportColumn {
  header: string
  type: 'text' | 'number' | 'datetime'
}
export interface ExportTable {
  /** The sheet name, and the start of the file name. */
  name: string
  columns: ExportColumn[]
  rows: ExportCell[][]
}

/** A list too long to export is answered with its size, so the page can ask for narrower filters. */
export type ExportResult = { ok: true; filename: string; table: ExportTable } | { ok: false; total: number; max: number }

interface Definition<Row> {
  name: string
  columns: Array<ExportColumn & { value: (row: Row) => ExportCell }>
}

const text = <Row>(header: string, value: (row: Row) => string | null | undefined) => ({ header, type: 'text' as const, value: (row: Row) => value(row) ?? null })
const number = <Row>(header: string, value: (row: Row) => number | null | undefined) => ({ header, type: 'number' as const, value: (row: Row) => value(row) ?? null })
const time = <Row>(header: string, value: (row: Row) => string | null | undefined) => ({ header: `${header} (UTC)`, type: 'datetime' as const, value: (row: Row) => value(row) ?? null })

const faceCheck = (biometric: CredentialRow['biometric']) => biometric?.status ?? null

type AuditRow = Awaited<ReturnType<typeof listAuditLog>>['items'][number]

export const TENANT_EXPORTS = {
  connections: {
    name: 'connections',
    columns: [
      text('External id', (row) => row.externalId),
      text('Holder label', (row) => row.theirLabel),
      text('State', (row) => row.state),
      text('Connection id', (row) => row.id),
      time('Created', (row) => row.createdAt),
      time('Updated', (row) => row.updatedAt),
      time('Personal data erased', (row) => row.erasedAt),
    ],
  } satisfies Definition<ConnectionRow>,
  credentials: {
    name: 'credential-exchanges',
    columns: [
      text('External id', (row) => row.externalId),
      text('State', (row) => row.state),
      text('Face check', (row) => faceCheck(row.biometric)),
      text('Credential definition', (row) => row.credentialDefinitionId),
      text('Error', (row) => row.errorMessage),
      text('Exchange id', (row) => row.id),
      text('Connection id', (row) => row.connectionId),
      time('Created', (row) => row.createdAt),
      time('Updated', (row) => row.updatedAt),
      time('Personal data erased', (row) => row.erasedAt),
    ],
  } satisfies Definition<CredentialRow>,
  proofs: {
    name: 'proof-exchanges',
    columns: [
      text('External id', (row) => row.externalId),
      text('State', (row) => row.state),
      text('Verified', (row) => (row.verified === null ? null : row.verified ? 'yes' : 'no')),
      text('Face check', (row) => faceCheck(row.biometric) ?? (row.biometricCondition ? 'not required' : null)),
      // Names only: the disclosed values are personal data.
      text('Disclosed attributes', (row) => Object.entries(row.disclosed ?? {}).map(([group, values]) => `${group}: ${Object.keys(values).join(', ')}`).join(' · ') || null),
      text('Template id', (row) => row.templateId),
      text('Error', (row) => row.errorMessage),
      text('Exchange id', (row) => row.id),
      text('Connection id', (row) => row.connectionId),
      time('Created', (row) => row.createdAt),
      time('Updated', (row) => row.updatedAt),
      time('Personal data erased', (row) => row.erasedAt),
    ],
  } satisfies Definition<ProofRow>,
  wallets: {
    name: 'wallets',
    columns: [
      text('External id', (row) => row.externalId),
      text('Status', (row) => (row.revokedAt ? 'revoked' : 'active')),
      text('Wallet id', (row) => row.id),
      time('Created', (row) => row.createdAt),
      time('First connected', (row) => row.connectedAt),
      time('Last wake-up', (row) => row.lastSyncRequestedAt),
      time('Revoked', (row) => row.revokedAt),
      text('Revoked because', (row) => row.revokedReason),
    ],
  } satisfies Definition<WalletRow>,
  checks: {
    name: 'face-checks',
    columns: [
      time('Started', (row) => row.createdAt),
      text('For', (row) => KIND_LABELS[row.recordType]),
      text('External id', (row) => row.externalId),
      text('Outcome', (row) => row.biometric.status),
      number('Attempts', (row) => row.biometric.attempts),
      number('Liveness score', (row) => row.biometric.livenessScore),
      number('Liveness minimum', (row) => row.thresholds.minLivenessScore),
      number('Match score', (row) => row.biometric.matchScore),
      number('Match minimum', (row) => row.thresholds.minMatchScore),
      text('Reason', (row) => (row.biometric.status === 'passed' || !row.biometric.reason ? null : reasonLabel(row.biometric.reason))),
      time('Decided', (row) => row.biometric.decidedAt),
      text('Provider', (row) => row.providerId),
      text('Exchange id', (row) => row.recordId),
      text('Connection id', (row) => row.connectionId),
    ],
  } satisfies Definition<CheckRow>,
  deliveries: {
    name: 'webhook-deliveries',
    columns: [
      number('Delivery', (row) => row.id),
      text('Event', (row) => row.eventType),
      text('Status', (row) => row.status),
      number('Attempts', (row) => row.attempts),
      number('Last response code', (row) => row.lastStatusCode),
      text('Last error', (row) => row.lastError),
      text('Event id', (row) => row.eventId),
      time('Created', (row) => row.createdAt),
      time('Delivered', (row) => row.deliveredAt),
      time('Personal data erased', (row) => row.erasedAt),
    ],
  } satisfies Definition<DeliveryRow>,
}
export type TenantExportList = keyof typeof TENANT_EXPORTS
export const TENANT_EXPORT_LISTS = Object.keys(TENANT_EXPORTS) as [TenantExportList, ...TenantExportList[]]

export const OPS_EXPORTS = {
  audit: {
    name: 'audit-log',
    columns: [
      time('When', (row) => row.at),
      text('Actor', (row) => row.actorEmail ?? row.actor),
      text('Actor id', (row) => row.actor),
      text('Role', (row) => row.role),
      text('Tenant id', (row) => row.tenantId),
      text('Action', (row) => auditAction(row).text),
      text('Result', (row) => auditResult(row)),
      text('Reason', (row) => row.reason),
      // Already stripped of secrets and personal data when it was stored (review L10).
      text('Details', (row) => row.changes),
      text('Method', (row) => row.method),
      text('Route or event', (row) => row.route),
      number('Status code', (row) => row.statusCode),
      text('Request id', (row) => row.requestId),
    ],
  } satisfies Definition<AuditRow>,
}
export type OpsExportList = keyof typeof OPS_EXPORTS
export const OPS_EXPORT_LISTS = Object.keys(OPS_EXPORTS) as [OpsExportList, ...OpsExportList[]]

/** The table of an export: the definition's columns, and one row of cells per record. */
export function tableOf<Row>(definition: Definition<Row>, records: Row[]): ExportTable {
  return {
    name: definition.name,
    columns: definition.columns.map(({ header, type }) => ({ header, type })),
    rows: records.map((record) => definition.columns.map((column) => column.value(record))),
  }
}

/** `face-checks-2026-10-12.xlsx`: what it is and the day it was taken. */
export const exportFilename = (name: string, format: ExportFormat, now = new Date()) => `${name}-${now.toISOString().slice(0, 10)}.${format}`
