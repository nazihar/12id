import { useHydrated } from '@tanstack/react-router'
import { type ColumnDef, type RowData, useTable } from '@tanstack/react-table'
import { ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon, XIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { PageSize } from '@/lib/list-search'
import { cn } from '@/lib/utils'

import { type DataTableFeatures, features } from './data-table-features'
import { PageSizeMenu, SearchInput } from './list-toolbar'

export interface DataTablePaging {
  page: number
  pageSize: number
  total: number
  onChange: (next: { page?: number; pageSize?: PageSize }) => void
}

interface DataTableProps<TData extends RowData> {
  columns: ColumnDef<DataTableFeatures, TData>[]
  /** One page of rows as the server returned it (newest first). */
  data: TData[]
  /** Server paging; without it the table shows every row it is given (short, bounded lists only). */
  paging?: DataTablePaging
  /** A debounced search box, written to the URL by the caller. */
  search?: { value?: string; placeholder: string; onChange: (value: string | undefined) => void }
  emptyMessage?: string
  testId?: string
  /** Filter buttons, shown after the search box. */
  toolbar?: ReactNode
  /** Shown as a Reset button while any search or filter is set. */
  onReset?: () => void
  /** Actions on the whole list (the Export button), at the end of the toolbar row. */
  actions?: ReactNode
  /** A newer page is loading; the current rows stay visible, dimmed. */
  fetching?: boolean
}

// shadcn's TanStack Table v9 data-table recipe, driven by the server since Phase 4 C9: the page,
// search and filters live in the URL and platform-api answers one page at a time. No sort controls.
export function DataTable<TData extends RowData>({ columns, data, paging, search, emptyMessage = 'Nothing here yet.', testId, toolbar, onReset, actions, fetching }: DataTableProps<TData>) {
  const table = useTable({ features, columns, data })
  const rows = table.getRowModel().rows

  return (
    <div className="space-y-3" data-testid={testId}>
      {(search || toolbar || actions) && (
        <div className="flex flex-wrap items-center gap-2">
          {search && <SearchInput value={search.value} placeholder={search.placeholder} onChange={search.onChange} />}
          {toolbar}
          {onReset && (
            <Button variant="ghost" size="sm" className="h-8" onClick={onReset}>
              Reset
              <XIcon />
            </Button>
          )}
          {actions && <div className="ml-auto">{actions}</div>}
        </div>
      )}
      {/* The table scrolls inside this box; the page itself never grows wider than the window. */}
      <div className={cn('w-full max-w-full overflow-x-auto rounded-lg border transition-opacity', fetching && 'opacity-60')} aria-busy={fetching || undefined}>
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead key={header.id}>{header.isPlaceholder ? null : <table.FlexRender header={header} />}</TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length > 0 ? (
              rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-16 text-center text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {paging && paging.total > 0 && <Pager {...paging} />}
    </div>
  )
}

function Pager({ page, pageSize, total, onChange }: DataTablePaging) {
  // A click before hydration would do nothing; the controls wait for it, like every form (C7).
  const hydrated = useHydrated()
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = Math.min(total, (page - 1) * pageSize + 1)
  const last = Math.min(total, page * pageSize)
  return (
    <nav className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground" aria-label="Pagination">
      <span data-testid="pager-range" className="tabular-nums">
        {page > pages ? `Page ${page} is past the end` : `${first}–${last} of ${total}`}
      </span>
      <div className="flex items-center gap-2">
        <PageSizeMenu value={pageSize as PageSize} onChange={(size) => onChange({ pageSize: size, page: undefined })} />
        <span className="tabular-nums">
          Page {page} of {pages}
        </span>
        <Button variant="outline" size="icon-sm" aria-label="First page" onClick={() => onChange({ page: undefined })} disabled={!hydrated || page <= 1}>
          <ChevronsLeftIcon />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Previous page" onClick={() => onChange({ page: page - 1 > 1 ? Math.min(page - 1, pages) : undefined })} disabled={!hydrated || page <= 1}>
          <ChevronLeftIcon />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Next page" onClick={() => onChange({ page: page + 1 })} disabled={!hydrated || page >= pages}>
          <ChevronRightIcon />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Last page" onClick={() => onChange({ page: pages > 1 ? pages : undefined })} disabled={!hydrated || page >= pages}>
          <ChevronsRightIcon />
        </Button>
      </div>
    </nav>
  )
}
