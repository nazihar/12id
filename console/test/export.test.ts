import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { type ExportTable, OPS_EXPORTS, TENANT_EXPORTS, exportFilename, tableOf } from '../src/features/export/export.lists'
import type { CredentialRow, ProofRow } from '../src/features/tenant-data/types'
import { toCsv } from '../src/lib/export/csv'
import { toXlsx } from '../src/lib/export/xlsx'
import { tenantCan } from '../src/lib/permissions'

const table: ExportTable = {
  name: 'credential-exchanges',
  columns: [
    { header: 'External id', type: 'text' },
    { header: 'Attempts', type: 'number' },
    { header: 'Created (UTC)', type: 'datetime' },
    { header: 'Holder label', type: 'text' },
  ],
  rows: [
    ['00123456789012345', 2, '2026-10-11T10:54:07.000Z', 'Ada, "the first"'],
    ['1234567890123456', 0, '2026-10-12T00:00:00.000Z', '=HYPERLINK("http://evil.test","open")'],
    [null, null, null, '+1 555 0100\nsecond line'],
    ['-17', -17, null, '@handle'],
  ],
}

describe('CSV', () => {
  const csv = toCsv(table)
  const lines = csv.slice(1).split('\r\n')

  it('leads with a byte-order mark, ends every line with CRLF and has one line per row', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(lines[0]).toBe('External id,Attempts,Created (UTC),Holder label')
    // Header, four rows, and the empty piece after the last CRLF. The line break inside the third row's
    // quoted field is a bare LF, so it does not split a row.
    expect(lines).toHaveLength(6)
  })

  it('quotes a field with a comma, a quote or a line break, doubling the quotes', () => {
    expect(lines[1]).toBe('00123456789012345,2,2026-10-11T10:54:07.000Z,"Ada, ""the first"""')
    expect(csv).toContain('"\'+1 555 0100\nsecond line"')
  })

  it('keeps a text cell from being run as a formula, and leaves numbers and times alone', () => {
    expect(lines[2]).toBe('1234567890123456,0,2026-10-12T00:00:00.000Z,"\'=HYPERLINK(""http://evil.test"",""open"")"')
    // The reference "-17" is text someone else wrote; the number -17 is ours.
    expect(lines[4]).toBe("'-17,-17,,'@handle")
  })

  it('writes an empty cell for null', () => {
    expect(lines[3].startsWith(',,,')).toBe(true)
  })
})

describe('Excel', () => {
  it('keeps references as text, numbers as numbers and times as dates', async () => {
    const blob = await toXlsx(table)
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
    const strings = strFromU8(files['xl/sharedStrings.xml'])
    const workbook = strFromU8(files['xl/workbook.xml'])

    // A reference with leading zeros and a sixteen-digit one are stored as strings, exactly as written.
    expect(strings).toContain('>00123456789012345<')
    expect(strings).toContain('>1234567890123456<')
    expect(sheet).not.toContain('<v>123456789012345</v>')
    expect(sheet).not.toContain('<v>1234567890123456</v>')
    // A text that looks like a formula is a string cell, never a formula.
    expect(strings).toContain('=HYPERLINK(')
    expect(sheet).not.toContain('<f>')
    // The number column holds numbers, including the negative one.
    expect(sheet).toContain('<v>2</v>')
    expect(sheet).toContain('<v>-17</v>')
    // 2026-10-12T00:00:00Z is day 46307 in Excel's calendar: a date cell, in UTC.
    expect(sheet).toContain('<v>46307</v>')
    expect(workbook).toContain('name="credential-exchanges"')
    // The header row stays in view.
    expect(sheet).toMatch(/<pane [^>]*ySplit="1"/)
  })
})

describe('what an export contains', () => {
  const credential = {
    id: 'cred-1',
    state: 'done',
    connectionId: 'conn-1',
    threadId: 'thread-1',
    externalId: 'user-001',
    credentialDefinitionId: 'ABC:3:CL:12:default',
    attributes: { name: 'Ada Lovelace', accountNumber: '00123456789' },
    errorMessage: null,
    biometric: null,
    erasedAt: null,
    createdAt: '2026-10-11T10:54:07.000Z',
    updatedAt: '2026-10-11T10:55:00.000Z',
  } as CredentialRow
  const proof = {
    id: 'proof-1',
    state: 'done',
    connectionId: 'conn-1',
    threadId: 'thread-2',
    externalId: 'user-001',
    templateId: null,
    verified: true,
    disclosed: { employee: { name: 'Ada Lovelace', department: 'Engines' } },
    errorMessage: null,
    biometric: null,
    biometricCondition: null,
    erasedAt: null,
    createdAt: '2026-10-11T10:54:07.000Z',
    updatedAt: '2026-10-11T10:55:00.000Z',
  } as ProofRow

  it('never carries attribute values or disclosed values, only the names disclosed', () => {
    const credentials = tableOf(TENANT_EXPORTS.credentials, [credential])
    const proofs = tableOf(TENANT_EXPORTS.proofs, [proof])
    const everything = JSON.stringify([credentials, proofs])
    expect(everything).not.toContain('Ada Lovelace')
    expect(everything).not.toContain('00123456789')
    expect(everything).not.toContain('Engines')
    expect(proofs.rows[0]).toContain('employee: name, department')
    expect(proofs.rows[0]).toContain('yes')
  })

  it('has one cell per column, typed, with references as text and times as times', () => {
    const credentials = tableOf(TENANT_EXPORTS.credentials, [credential])
    expect(credentials.rows[0]).toHaveLength(credentials.columns.length)
    expect(credentials.columns.find((column) => column.header === 'External id')?.type).toBe('text')
    expect(credentials.columns.find((column) => column.header === 'Created (UTC)')?.type).toBe('datetime')
    for (const definition of [...Object.values(TENANT_EXPORTS), ...Object.values(OPS_EXPORTS)]) {
      expect(definition.columns.every((column) => column.type !== 'datetime' || column.header.endsWith('(UTC)'))).toBe(true)
    }
  })

  it('names the file after the list and the day', () => {
    expect(exportFilename('face-checks', 'xlsx', new Date('2026-10-12T08:00:00Z'))).toBe('face-checks-2026-10-12.xlsx')
    expect(exportFilename('audit-log', 'csv', new Date('2026-10-12T23:59:59Z'))).toBe('audit-log-2026-10-12.csv')
  })

  it('is for owners and admins of an organization, not for members', () => {
    expect(tenantCan('owner', { export: ['run'] })).toBe(true)
    expect(tenantCan('admin', { export: ['run'] })).toBe(true)
    expect(tenantCan('member', { export: ['run'] })).toBe(false)
  })
})
