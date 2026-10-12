/**
 * CSV for other systems (implement/22-console-feedback.md C12): a SIEM, a script, a warehouse.
 * RFC 4180: comma-separated, CRLF line ends, a field quoted when it holds a comma, a quote or a line
 * break, quotes doubled. A UTF-8 byte-order mark leads, so Excel reads non-ASCII text correctly.
 *
 * People do open CSV files in spreadsheets, where a cell starting with `=`, `+`, `-` or `@` is run
 * as a formula. External ids, holder labels and audit details are text someone else wrote, so every
 * text cell that starts with one of those (or a tab or carriage return, which reach the same parser)
 * gets a leading apostrophe. Numbers and times are ours and stay as they are.
 */
import type { ExportCell, ExportTable } from '@/features/export/export.lists'

const BOM = '﻿'
const FORMULA_START = /^[=+\-@\t\r]/
const NEEDS_QUOTES = /[",\r\n]/

const quoted = (value: string) => (NEEDS_QUOTES.test(value) ? `"${value.replaceAll('"', '""')}"` : value)

function field(cell: ExportCell, type: ExportTable['columns'][number]['type']): string {
  if (cell === null) return ''
  if (typeof cell === 'number') return String(cell)
  return quoted(type === 'text' && FORMULA_START.test(cell) ? `'${cell}` : cell)
}

export function toCsv(table: ExportTable): string {
  const lines = [table.columns.map((column) => quoted(column.header)).join(',')]
  for (const row of table.rows) lines.push(row.map((cell, index) => field(cell, table.columns[index].type)).join(','))
  return `${BOM}${lines.join('\r\n')}\r\n`
}
