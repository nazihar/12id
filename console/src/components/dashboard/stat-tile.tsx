import type { ReactNode } from 'react'

import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * One headline number (Phase 4 C8). A row of these is the KPI row; the value is the point, so it is
 * the only large text, and the sub-line carries context (in flight, of total, …) in muted ink.
 */
export function StatTile({ label, value, sub, testId, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; testId?: string; className?: string }) {
  return (
    <Card size="sm" className={cn('gap-1', className)} data-testid={testId}>
      <CardContent className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="font-heading text-2xl leading-none font-semibold">{value}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  )
}

/** Responsive KPI row: two tiles on a phone, four on a wide screen. */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-4', className)}>{children}</div>
}
