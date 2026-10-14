/**
 * How the audit log names what the console reports about itself (implement/22-console-feedback.md C13):
 * sign-ins, account changes and exports arrive as rows with method `EVENT` and their type as the route.
 * Client-safe. A type without a label here is shown as it is stored.
 */
export const AUDIT_EVENT_METHOD = 'EVENT'

export const AUDIT_KINDS = ['change', 'sign-in', 'account', 'export', 'approval'] as const
export type AuditKind = (typeof AUDIT_KINDS)[number]

export const auditKindOptions: Array<{ value: AuditKind; label: string }> = [
  { value: 'change', label: 'Changes' },
  { value: 'sign-in', label: 'Sign-ins' },
  { value: 'account', label: 'Accounts' },
  { value: 'export', label: 'Exports' },
  // implement/22 C17: every call that was held, decided or applied for a second person.
  { value: 'approval', label: 'Approvals' },
]

const EVENT_LABELS: Record<string, string> = {
  'auth.sign_in': 'Signed in',
  'auth.sign_in_failed': 'Sign-in failed',
  'auth.second_factor_failed': 'Second factor failed',
  'auth.sign_out': 'Signed out',
  'auth.password_reset_requested': 'Password reset requested',
  'auth.password_reset': 'Password set',
  'auth.two_factor_enrolled': 'Two-factor set up',
  'auth.locked': 'Locked after wrong passwords',
  'auth.idle_sign_out': 'Signed out after inactivity',
  'auth.session_replaced': 'Signed out by a newer sign-in',
  'auth.password_changed': 'Password changed',
  'auth.password_expired': 'Password expired',
  'account.operator_invited': 'Operator invited',
  'account.operator_updated': 'Operator changed',
  'account.operator_role_changed': 'Operator role changed',
  'account.operator_banned': 'Operator disabled',
  'account.operator_unbanned': 'Operator re-enabled',
  'account.operator_sessions_revoked': 'Operator signed out everywhere',
  'account.operator_deleted': 'Operator deleted',
  'account.organization_created': 'Organization created',
  'account.member_invited': 'Member invited',
  'account.invitation_cancelled': 'Invitation cancelled',
  'account.invitation_accepted': 'Invitation accepted',
  'account.member_role_changed': 'Member role changed',
  'account.member_removed': 'Member removed',
  'account.unlocked': 'Account unlocked',
  'account.reenabled': 'Account re-enabled',
  'account.disabled_inactive': 'Disabled after inactivity',
  'account.password_link_sent': 'Password link sent',
  'account.role_created': 'Role created',
  'account.role_updated': 'Role changed',
  'account.role_deleted': 'Role deleted',
  'account.membership_disabled': 'Member disabled in the organization',
  'account.membership_reenabled': 'Member re-enabled in the organization',
  'account.session_ended': 'Session ended',
  'export.run': 'List exported',
  // Written by platform-api's retention pass (implement/22 C15), not by a person.
  'audit.purged': 'Old audit entries deleted',
}

/** What an audit row did, for a person: an event's name, or the call as `METHOD /route`. */
export function auditAction(entry: { method: string; route: string }): { text: string; event: boolean } {
  if (entry.method !== AUDIT_EVENT_METHOD) return { text: `${entry.method} ${entry.route}`, event: false }
  return { text: EVENT_LABELS[entry.route] ?? entry.route, event: true }
}

/** An event has an outcome, not an HTTP status. */
export const auditResult = (entry: { method: string; statusCode: number }) => (entry.method !== AUDIT_EVENT_METHOD ? String(entry.statusCode) : entry.statusCode < 400 ? 'ok' : 'refused')
