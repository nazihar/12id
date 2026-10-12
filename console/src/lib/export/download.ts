/**
 * Hands a file the page built to the browser's download (implement/22-console-feedback.md C12).
 * Browser only. The file is made from rows a guarded server function returned, so an export needs
 * no route of its own and nothing binary crosses the server-function boundary.
 */
import type { ExportFormat, ExportTable } from '@/features/export/export.lists'

import { toCsv } from './csv'
import { toXlsx } from './xlsx'

export async function fileOf(table: ExportTable, format: ExportFormat): Promise<Blob> {
  return format === 'xlsx' ? toXlsx(table) : new Blob([toCsv(table)], { type: 'text/csv;charset=utf-8' })
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  // The click has started the download; the URL can go once the browser has picked it up.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
