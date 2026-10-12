/**
 * Excel for people (implement/22-console-feedback.md C12). A real `.xlsx` has typed cells, which is
 * the point of offering it next to CSV: opening a CSV, Excel turns `00123` into 123 and a
 * sixteen-digit reference into 1.23E+15, and reads dates by the PC's locale. Here a reference is a
 * text cell and stays as written, a time is a date cell, and a text cell is never run as a formula.
 *
 * `write-excel-file` (write-only, one dependency) is imported when someone exports, so it is a
 * chunk of its own and no page pays for it.
 */
import type { ExportTable } from '@/features/export/export.lists'

const DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss'
const MAX_SHEET_NAME = 31
const MIN_WIDTH = 10
const MAX_WIDTH = 60

/** Wide enough for the header and for what the first rows hold, within bounds. */
function widths(table: ExportTable) {
  return table.columns.map((column, index) => {
    if (column.type === 'datetime') return { width: Math.max(DATE_FORMAT.length + 2, column.header.length + 2) }
    const longest = table.rows.slice(0, 200).reduce((max, row) => Math.max(max, String(row[index] ?? '').length), column.header.length)
    return { width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest + 2)) }
  })
}

export async function toXlsx(table: ExportTable): Promise<Blob> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser')
  const header = table.columns.map((column) => ({ value: column.header, type: String, fontWeight: 'bold' as const }))
  const rows = table.rows.map((row) =>
    row.map((cell, index) => {
      if (cell === null) return null
      const { type } = table.columns[index]
      // The library writes a date by its UTC parts, so the sheet shows UTC, as the header says.
      if (type === 'datetime') return { value: new Date(cell), type: Date, format: DATE_FORMAT }
      if (type === 'number' && typeof cell === 'number') return { value: cell, type: Number }
      return { value: String(cell), type: String }
    })
  )
  return writeXlsxFile([header, ...rows], { sheet: table.name.slice(0, MAX_SHEET_NAME), columns: widths(table), stickyRowsCount: 1 }).toBlob()
}
