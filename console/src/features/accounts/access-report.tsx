/**
 * The access report above the Operators and Members lists (implement/26): who has access, in what
 * state, and who is signed in now. The same states filter the list below it.
 */
import { StatGrid, StatTile } from '@/components/dashboard/stat-tile'

export interface AccessReportData {
  total: number
  active: number
  locked: number
  disabled: number
  inactive: number
  neverSignedIn: number
  withoutTwoFactor: number
  signedInNow: number
  byRole: { role: string; count: number }[]
}

export function AccessReport({ report, roleLabel = (role) => role }: { report: AccessReportData; roleLabel?: (role: string) => string }) {
  const roles = [...report.byRole].sort((a, b) => b.count - a.count).map((row) => `${row.count} ${roleLabel(row.role)}`)
  return (
    <StatGrid>
      <StatTile label="Accounts" value={report.total} sub={roles.length > 0 ? roles.join(' · ') : 'none yet'} testId="access-total" />
      <StatTile label="Active" value={report.active} sub={`${report.signedInNow} signed in now · ${report.withoutTwoFactor} without two-factor`} testId="access-active" />
      <StatTile label="Locked or disabled" value={report.locked + report.disabled + report.inactive} sub={`${report.locked} locked · ${report.disabled} disabled · ${report.inactive} unused`} testId="access-closed" />
      <StatTile label="Never signed in" value={report.neverSignedIn} sub="invited, no sign-in yet" testId="access-never" />
    </StatGrid>
  )
}
