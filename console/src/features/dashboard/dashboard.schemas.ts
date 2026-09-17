/** Client-safe: the dashboard range, shared by the route search params and the server-function validators. */
import { z } from 'zod'

export const DASHBOARD_RANGES = [7, 30, 90] as const
export type DashboardRange = (typeof DASHBOARD_RANGES)[number]

export const dashboardRangeInput = z.object({ days: z.literal(DASHBOARD_RANGES).default(30) })
export type DashboardRangeInput = z.input<typeof dashboardRangeInput>

export const DEFAULT_DASHBOARD_RANGE: DashboardRange = 30

/**
 * Route `validateSearch`: `days` is kept only when it is one of the presets, so the default never
 * lands in the URL and an unknown value is dropped instead of erroring. Resolve with `rangeOf`.
 */
export function parseDashboardSearch(search: Record<string, unknown>): { days?: DashboardRange } {
  const parsed = dashboardRangeInput.safeParse({ days: typeof search.days === 'string' ? Number(search.days) : search.days })
  return parsed.success && search.days !== undefined ? { days: parsed.data.days } : {}
}

export const rangeOf = (search: { days?: DashboardRange }): DashboardRange => search.days ?? DEFAULT_DASHBOARD_RANGE
