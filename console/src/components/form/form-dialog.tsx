import { useHydrated } from '@tanstack/react-router'
import { type ReactElement, type ReactNode, useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/**
 * A short form in a dialog, opened from a page header. The form is mounted only while open, so every
 * opening starts clean; the form calls `close()` after a successful submit and keeps the dialog open
 * (with its own error) after a failure.
 */
export function FormDialog({
  trigger,
  title,
  description,
  children,
  size = 'sm',
  open: controlledOpen,
  onOpenChange,
}: {
  trigger?: ReactElement
  title: ReactNode
  description?: ReactNode
  children: (props: { close: () => void }) => ReactNode
  size?: 'sm' | 'md' | 'lg'
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const hydrated = useHydrated()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger render={trigger} disabled={!hydrated} />}
      {/* A form taller than the window scrolls inside the dialog instead of running off both edges. */}
      <DialogContent className={cn('max-h-[calc(100svh-2rem)] overflow-y-auto overscroll-contain', size === 'md' && 'sm:max-w-lg', size === 'lg' && 'sm:max-w-2xl')}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {open && children({ close: () => setOpen(false) })}
      </DialogContent>
    </Dialog>
  )
}
