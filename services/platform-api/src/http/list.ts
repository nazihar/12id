/**
 * Shared shape of every list route (Phase 4 C9, 11-phase-4.md §C9): page numbers with a total,
 * one fixed order (`created_at desc`, primary key as tie-break), search and filters as query
 * parameters. Every list answers `{ items, total, page, pageSize }`.
 */
import { type SQL, and, count, sql } from 'drizzle-orm'
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core'
import { z } from 'zod'

import type { Database } from '../db/client.ts'

export const PAGE_SIZES = [25, 50, 100] as const

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((n) => (PAGE_SIZES as readonly number[]).includes(n), { message: `pageSize must be one of ${PAGE_SIZES.join(', ')}` })
    .default(25)
    .describe('25, 50 or 100.'),
})

/** `created_at >= from and created_at < to`; the console sends UTC day bounds. */
export const createdRange = z.object({
  from: z.iso.datetime({ offset: true }).optional().describe('Created at or after this instant (ISO 8601).'),
  to: z.iso.datetime({ offset: true }).optional().describe('Created before this instant (ISO 8601).'),
})

export const searchQuery = z.object({ q: z.string().trim().min(1).max(100).optional().describe('Case-insensitive contains match.') })

/** One value or a repeated query parameter (`state=a&state=b`). */
export const oneOrMany = (item: z.ZodString) => z.union([item, z.array(item).max(20)]).optional()
export const many = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value])

export const pageOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() })

export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

/** `col ILIKE '%term%'` with the LIKE wildcards in `term` taken literally. */
export function containsI(col: AnyPgColumn | SQL, term: string): SQL {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`)
  return sql`${col} ilike ${`%${escaped}%`}`
}

export function createdBetween(col: AnyPgColumn, range: { from?: string; to?: string }): SQL[] {
  const filters: SQL[] = []
  if (range.from) filters.push(sql`${col} >= ${new Date(range.from)}`)
  if (range.to) filters.push(sql`${col} < ${new Date(range.to)}`)
  return filters
}

/**
 * The fixed order of every list: newest first, the primary key as tie-break.
 *
 * Written with NULLS LAST because that is how the list indexes are declared: drizzle's `.desc()` in
 * an index is `DESC NULLS LAST`, while a plain `ORDER BY … DESC` means NULLS FIRST. Postgres reads a
 * page's order straight from an index only when the two agree; with a plain `desc()` it fetched and
 * sorted every row of the tenant for each page (found in implement/23, 2026-10-11). The columns are
 * NOT NULL, so the rows and their order are the same either way.
 */
export const newestFirst = (createdAt: AnyPgColumn, id: AnyPgColumn): [SQL, SQL] => [sql`${createdAt} desc nulls last`, sql`${id} desc nulls last`]

/** Rows of one page (the callback applies the order) and the total under the same filter, in parallel. */
export async function listPage<TRow>(
  db: Database,
  input: { table: PgTable; where: SQL[]; page: number; pageSize: number },
  rows: (where: SQL | undefined, limit: number, offset: number) => Promise<TRow[]>
): Promise<Page<TRow>> {
  const where = input.where.length ? and(...input.where) : undefined
  const [items, [{ total }]] = await Promise.all([
    rows(where, input.pageSize, (input.page - 1) * input.pageSize),
    db.select({ total: count() }).from(input.table).where(where),
  ])
  return { items, total, page: input.page, pageSize: input.pageSize }
}
