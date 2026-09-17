import { type ColumnDef, type PaginationState, type RowData, type SortingState, useTable } from '@tanstack/react-table'
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

import { type DataTableFeatures, features } from './data-table-features'

interface DataTableProps<TData extends RowData> {
  columns: ColumnDef<DataTableFeatures, TData>[]
  /** Pass query data directly; a new array each render resets the table's models. */
  data: TData[]
  /** Shows a search box over the text columns when set. */
  searchPlaceholder?: string
  emptyMessage?: string
  pageSize?: number
  testId?: string
  /** Filters or actions shown on the search row, right-aligned. */
  toolbar?: ReactNode
}

// shadcn's TanStack Table v9 data-table recipe, with client-side sorting, search and pagination.
export function DataTable<TData extends RowData>({ columns, data, searchPlaceholder, emptyMessage = 'Nothing here yet.', pageSize = 25, testId, toolbar }: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize })

  const table = useTable({
    features,
    columns,
    data,
    state: { sorting, globalFilter, pagination },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    globalFilterFn: 'includesString',
    enableSortingRemoval: false,
  })
  const rows = table.getRowModel().rows

  return (
    <div className="space-y-3" data-testid={testId}>
      {(searchPlaceholder || toolbar) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {searchPlaceholder ? (
            <Input value={globalFilter} onChange={(event) => table.setGlobalFilter(event.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} className="max-w-xs" />
          ) : (
            <span />
          )}
          {toolbar}
        </div>
      )}
      {/* The table scrolls inside this box; the page itself never grows wider than the window. */}
      <div className="w-full max-w-full overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={header.column.getToggleSortingHandler()}>
                        <table.FlexRender header={header} />
                        {header.column.getIsSorted() === 'asc' ? (
                          <ArrowUpIcon className="size-3" />
                        ) : header.column.getIsSorted() === 'desc' ? (
                          <ArrowDownIcon className="size-3" />
                        ) : (
                          <ArrowUpDownIcon className="size-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
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
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <span>
            Page {pagination.pageIndex + 1} of {table.getPageCount()}
          </span>
          <Button variant="outline" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            Previous
          </Button>
          <Button variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
