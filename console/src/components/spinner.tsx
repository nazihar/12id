import { Loader2Icon } from 'lucide-react'

import { cn } from '@/lib/utils'

/** The one "working on it" mark: submit buttons, confirmation dialogs, anything that waits. */
export function Spinner({ className }: { className?: string }) {
  return <Loader2Icon aria-hidden className={cn('animate-spin', className)} />
}
