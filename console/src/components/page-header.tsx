import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Title row of a page or a page section. `actions` is the one place a page's "New …" buttons live, so
 * forms never share a column with the table they feed.
 */
export function PageHeader({ title, description, actions, badge, meta, level = 1, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; badge?: ReactNode; meta?: ReactNode; level?: 1 | 2; className?: string }) {
  const Heading = level === 1 ? 'h1' : 'h2'
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Heading className={cn('font-heading font-medium', level === 1 ? 'text-lg' : 'text-base')}>{title}</Heading>
          {badge}
        </div>
        {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
        {meta}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
