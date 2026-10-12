/** Pure figures of the Verification and customer pages (client-safe), so the arithmetic is tested once. */

/** `n` as a whole percentage of `of`; a dash when there is nothing to divide by. */
export const percent = (n: number, of: number) => (of === 0 ? '—' : `${Math.round((n / of) * 100)}%`)

/** Proof requests that reached an outcome: only those say anything about success. */
export const finishedProofs = (proofs: { verified: number; failed: number; abandoned: number }) => proofs.verified + proofs.failed + proofs.abandoned

/** Face checks that were decided: passed, failed, or ran out of time. Open and cancelled ones are not outcomes. */
export const decidedChecks = (byStatus: { passed: number; failed: number; expired: number }) => byStatus.passed + byStatus.failed + byStatus.expired

/** One series per chart column: failed and abandoned are both "not verified" there; the tiles give the split. */
export const proofColumns = (series: Array<{ day: string; verified: number; failed: number; abandoned: number; inFlight: number }>) =>
  series.map((point) => ({ day: point.day, verified: point.verified, inFlight: point.inFlight, notVerified: point.failed + point.abandoned }))

/** Failed and expired checks share a column segment: either way the person did not pass. */
export const checkColumns = (series: Array<{ day: string; passed: number; failed: number; expired: number; open: number; cancelled: number }>) =>
  series.map((point) => ({ day: point.day, passed: point.passed, open: point.open, notPassed: point.failed + point.expired, cancelled: point.cancelled }))

/** "1 attempt: 12 · 2 attempts: 3", or null when no check has passed. */
export function attemptsSummary(rows: Array<{ attempts: number; checks: number }>): string | null {
  if (rows.length === 0) return null
  return rows.map((row) => `${row.attempts} attempt${row.attempts === 1 ? '' : 's'}: ${row.checks}`).join(' · ')
}
