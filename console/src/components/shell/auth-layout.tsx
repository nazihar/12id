import type { ReactNode } from 'react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

import { ThemeToggle } from './theme-toggle'

/** Centered card for the pages outside the shell: sign-in, second factor, password, invitations. */
export function AuthLayout({ title, description, children, size = 'sm' }: { title: ReactNode; description?: ReactNode; children?: ReactNode; size?: 'sm' | 'md' }) {
  return (
    <main className="relative flex min-h-svh items-center justify-center p-6">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className={cn('w-full space-y-4', size === 'sm' ? 'max-w-sm' : 'max-w-md')}>
        <p className="text-center font-heading text-base font-semibold tracking-tight">12iD</p>
        <Card>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </CardHeader>
          {children && <CardContent>{children}</CardContent>}
        </Card>
      </div>
    </main>
  )
}
