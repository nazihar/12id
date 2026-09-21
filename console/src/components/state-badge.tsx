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
  expired: 'bad',
  cancelled: 'neutral',
  untested: 'neutral',
  deprecated: 'neutral',
  owner: 'role',
  admin: 'role',
  member: 'role',
  operator: 'role',
}

const VARIANTS = { good: 'secondary', active: 'outline', bad: 'destructive', neutral: 'ghost', role: 'outline' } as const

/** One look for tenant, exchange, delivery, schema, account and role states. Unknown states render neutral. */
export function StateBadge({ state }: { state: string }) {
  return <Badge variant={VARIANTS[TONES[state] ?? 'neutral']}>{state}</Badge>
}
