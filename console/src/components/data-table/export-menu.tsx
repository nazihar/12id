/**
 * The Export button of a list (implement/22-console-feedback.md C12): the rows the list holds under
 * its current filters, as an Excel file (for people) or a CSV file (for other systems). The page
 * passes a function that asks the server for the rows; the file is built here, in the browser.
 */
import { useHydrated } from '@tanstack/react-router'
import { DownloadIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Spinner } from '@/components/spinner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { ExportFormat, ExportResult } from '@/features/export/export.lists'
import { fileOf, saveBlob } from '@/lib/export/download'

export type Exporter = (format: ExportFormat) => Promise<ExportResult>

const FORMATS: Array<{ format: ExportFormat; label: string; hint: string }> = [
  { format: 'xlsx', label: 'Excel (.xlsx)', hint: 'to open and read' },
  { format: 'csv', label: 'CSV (.csv)', hint: 'for another system' },
]

export function ExportMenu({ onExport }: { onExport: Exporter }) {
  const hydrated = useHydrated()
  const [pending, setPending] = useState(false)

  async function run(format: ExportFormat) {
    setPending(true)
    try {
      const result = await onExport(format)
      if (!result.ok) {
        toast.error(`This list has ${result.total} rows; one export holds up to ${result.max}. Narrow the filters and export again.`)
        return
      }
      saveBlob(await fileOf(result.table, format), result.filename)
      const rows = result.table.rows.length
      toast.success(`${rows} row${rows === 1 ? '' : 's'} exported to ${result.filename}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The export failed.')
    } finally {
      setPending(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={!hydrated || pending}
        render={
          <Button variant="outline" size="sm" className="h-8" data-testid="export-menu">
            {pending ? <Spinner /> : <DownloadIcon />}
            Export
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-auto min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>This list, as filtered</DropdownMenuLabel>
          {FORMATS.map(({ format, label, hint }) => (
            <DropdownMenuItem key={format} onClick={() => void run(format)}>
              <span>{label}</span>
              <span className="ml-auto pl-4 text-xs text-muted-foreground">{hint}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
