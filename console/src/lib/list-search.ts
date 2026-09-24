/**
 * Client-safe list state (Phase 4 C9, 11-phase-4.md §C9). Every list page keeps its page, page size,
 * search and filters in the URL; the same schemas validate the route search and the server functions.
 * platform-api pages on the server, newest first, and answers `{ items, total, page, pageSize }`.
 */
import { z } from 'zod'

export const PAGE_SIZES = [25, 50, 100] as const
export type PageSize = (typeof PAGE_SIZES)[number]
export const DEFAULT_PAGE_SIZE: PageSize = 25

export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-09-24')

/** The base of every list's search: all optional, so defaults stay out of the URL. */
export const listSearch = z.object({
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z.literal(PAGE_SIZES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
})

/** Lists that also filter by creation day (`from` / `to` inclusive, UTC days). */
export const datedListSearch = listSearch.extend({ from: day.optional(), to: day.optional() })

export type ListSearch = z.infer<typeof listSearch>
export type DatedListSearch = z.infer<typeof datedListSearch>

/**
 * Route `validateSearch` for a list schema: every key is checked on its own and an invalid value is
 * dropped rather than failing the page (like `parseDashboardSearch`). Numbers typed into the URL
 * arrive as strings or numbers; a single value for an array key becomes a one-item array.
 */
export function parseListSearch<S extends z.ZodObject>(schema: S) {
  return (raw: Record<string, unknown>): Partial<z.infer<S>> => {
    const out: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodType][]) {
      let value = raw[key]
      if (value === undefined || value === '') continue
      if ((key === 'page' || key === 'pageSize') && typeof value === 'string') value = Number(value)
      let parsed = field.safeParse(value)
      if (!parsed.success && !Array.isArray(value)) parsed = field.safeParse([value])
      if (parsed.success && parsed.data !== undefined) out[key] = parsed.data
    }
    return out as Partial<z.infer<S>>
  }
}

/** What platform-api's list routes take for paging and search. */
export const pageParams = (search: ListSearch) => ({ page: search.page ?? 1, pageSize: search.pageSize ?? DEFAULT_PAGE_SIZE, q: search.q })

/** UTC day bounds for platform-api's `from` (inclusive) / `to` (exclusive). */
export function createdParams(search: { from?: string; to?: string }) {
  const next = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString()
  return { from: search.from ? `${search.from}T00:00:00.000Z` : undefined, to: search.to ? next(search.to) : undefined }
}

/** A LIKE pattern for a case-insensitive contains search; `%`, `_` and `\` in the term are literal. */
export const likeContains = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/** Reads every page of a list (for pickers that need all of a small list). Stops at 50 pages as a guard. */
export async function allPages<T>(fetchPage: (page: number) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = []
  for (let page = 1; page <= 50; page += 1) {
    const result = await fetchPage(page)
    items.push(...result.items)
    if (result.items.length === 0 || items.length >= result.total) break
  }
  return items
}

/** Search keys that are filters (not paging or the tab). */
export const isFiltered = (search: Record<string, unknown>) => Object.entries(search).some(([key, value]) => key !== 'page' && key !== 'pageSize' && key !== 'tab' && value !== undefined)

/** Drops empty values and defaults, so the URL only carries what differs from the default list. */
export function cleanSearch<S extends Record<string, unknown>>(search: S): S {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue
    if (key === 'page' && value === 1) continue
    if (key === 'pageSize' && value === DEFAULT_PAGE_SIZE) continue
    out[key] = value
  }
  return out as S
}

type SearchNavigate = (options: { search: (prev: Record<string, unknown>) => Record<string, unknown>; replace?: boolean; resetScroll?: boolean }) => unknown

/**
 * Applies a patch to the route's search. A patch without `page` is a filter change and returns to
 * the first page; a paging patch names `page` (undefined = first page). Pass `Route.useNavigate()`.
 */
export function searchPatcher<S extends object>(navigate: unknown) {
  return (patch: Partial<S>) =>
    (navigate as SearchNavigate)({
      search: (prev) => cleanSearch({ ...prev, ...('page' in patch ? {} : { page: undefined }), ...patch }),
      replace: true,
      resetScroll: false,
    })
}

/** DataTable's Reset: clears the search and every filter (the tab and page size stay); undefined when nothing is set. */
export function resetFor<S extends object>(search: S, onSearch: (patch: Partial<S>) => void): (() => void) | undefined {
  const keys = Object.keys(search).filter((key) => key !== 'tab' && key !== 'page' && key !== 'pageSize' && (search as Record<string, unknown>)[key] !== undefined)
  if (keys.length === 0) return undefined
  return () => onSearch(Object.fromEntries(keys.map((key) => [key, undefined])) as Partial<S>)
}

/** DataTable paging wired to a search patcher. */
export const pagingFor = (page: Page<unknown>, onSearch: (patch: { page?: number; pageSize?: PageSize }) => void) => ({
  page: page.page,
  pageSize: page.pageSize,
  total: page.total,
  onChange: (next: { page?: number; pageSize?: PageSize }) => onSearch({ page: next.page, ...('pageSize' in next ? { pageSize: next.pageSize } : {}) }),
})
