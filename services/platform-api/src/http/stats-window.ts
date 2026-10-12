/** The window of every dashboard aggregate: the last `days` UTC days, today included. Shared by stats.ts and verification.ts. */
import { z } from 'zod'

export const DAYS_MIN = 7
export const DAYS_MAX = 90
export const daysQuery = z.object({ days: z.coerce.number().int().min(DAYS_MIN).max(DAYS_MAX).default(30) })
