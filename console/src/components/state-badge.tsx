import { Badge } from '@/components/ui/badge'

type Tone = 'good' | 'active' | 'bad' | 'neutral' | 'role'

const TONES: Record<string, Tone> = {
  ready: 'good',
  published: 'good',
  completed: 'good',
  done: 'good',
  'credential-issued': 'good',
  delivered: 'good',
  passed: 'good',
  ok: 'good',
  active: 'good',
  applied: 'good',
  approved: 'active',
  rejected: 'bad',
  provisioning: 'active',
  pending: 'active',
  sending: 'active',
  invitation: 'active',
  'request-received': 'active',
  'response-sent': 'active',
  'offer-sent': 'active',
  'request-sent': 'active',
  'presentation-received': 'active',
  failed: 'bad',
  dead: 'bad',
  abandoned: 'bad',
  declined: 'bad',
  revoked: 'bad',
  banned: 'bad',
  disabled: 'bad',
  locked: 'bad',
  inactive: 'bad',
  expired: 'bad',
  cancelled: 'neutral',
  untested: 'neutral',
  deprecated: 'neutral',
  owner: 'role',
  admin: 'role',
  member: 'role',
  operator: 'role',
  auditor: 'role',
}

const VARIANTS = { good: 'secondary', active: 'outline', bad: 'destructive', neutral: 'ghost', role: 'outline' } as const

/** One look for tenant, exchange, delivery, schema, account and role states. Unknown states render neutral. */
export function StateBadge({ state }: { state: string }) {
  return <Badge variant={VARIANTS[TONES[state] ?? 'neutral']}>{state}</Badge>
}

/** A role by the name people see, built-in or custom (implement/26). */
export function RoleBadge({ label }: { label: string }) {
  return <Badge variant="outline">{label}</Badge>
}
