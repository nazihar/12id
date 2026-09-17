import { Link, type LinkProps } from '@tanstack/react-router'
import { CircleAlertIcon, CircleCheckIcon, TriangleAlertIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export type AttentionLevel = 'warning' | 'critical'

export interface AttentionItem {
  key: string
  label: ReactNode
  /** What the reader should do about it, one line. */
  detail?: ReactNode
  count: number
  level: AttentionLevel
  /** Where the fix lives; omitted when the console has no page for it. */
  to?: LinkProps['to']
  params?: LinkProps['params']
  search?: LinkProps['search']
}

const ICONS = { warning: TriangleAlertIcon, critical: CircleAlertIcon } as const
const COLORS = { warning: 'text-status-warning', critical: 'text-status-critical' } as const

/**
 * What needs a person (Phase 4 C8). Every row is icon + label + count, so the level is never carried
 * by colour alone; items with a count of zero are left out and an empty list says so instead of vanishing.
 */
export function AttentionList({ items, title = 'Needs attention', description, testId }: { items: AttentionItem[]; title?: string; description?: string; testId?: string }) {
  const open = items.filter((item) => item.count > 0)
  return (
    <Card size="sm" data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        {open.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleCheckIcon className="size-4 text-status-good" aria-hidden />
            Nothing needs attention.
          </p>
        ) : (
          <ul className="divide-y">
            {open.map((item) => {
              const Icon = ICONS[item.level]
              const body = (
                <>
                  <Icon className={`size-4 shrink-0 ${COLORS[item.level]}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{item.label}</span>
                    {item.detail && <span className="block text-xs text-muted-foreground">{item.detail}</span>}
                  </span>
                  <span className="font-heading text-lg font-semibold tabular-nums">{item.count}</span>
                </>
              )
              return (
                <li key={item.key} data-testid={`attention-${item.key}`}>
                  {item.to ? (
                    <Link to={item.to} params={item.params} search={item.search} className="flex items-center gap-3 py-2 hover:bg-muted/50 -mx-2 rounded-md px-2">
                      {body}
                    </Link>
                  ) : (
                    <div className="flex items-center gap-3 py-2">{body}</div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
