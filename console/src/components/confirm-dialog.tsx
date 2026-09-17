import { useHydrated } from '@tanstack/react-router'
import { type ReactElement, type ReactNode, useState } from 'react'

import { Spinner } from '@/components/spinner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

export interface ConfirmDialogProps {
  /** The element that opens the dialog, usually a Button. Rendered through Base UI's `render`, so it keeps its own markup. */
  trigger: ReactElement
  title: ReactNode
  description: ReactNode
  confirmLabel: ReactNode
  pendingLabel?: ReactNode
  /** Tints the confirm button; use for anything that removes, revokes or cannot be undone. */
  destructive?: boolean
  /** Resolves when the action is done; a rejection keeps the dialog open and shows the message. */
  onConfirm: () => Promise<unknown>
  /** Extra content between the description and the buttons (for example a summary of what changes). */
  children?: ReactNode
}

/**
 * The one confirmation step for every state-changing action. The caller reports success (toast,
 * invalidation) in `onConfirm`; this dialog owns the pending state and the failure message.
 */
export function ConfirmDialog({ trigger, title, description, confirmLabel, pendingLabel = 'Working…', destructive, onConfirm, children }: ConfirmDialogProps) {
  const hydrated = useHydrated()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.')
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        setOpen(next)
        if (!next) setError(null)
      }}
    >
      {/* Disabled until hydration: a click before then would do nothing (12-phase-4-findings.md). */}
      <AlertDialogTrigger render={trigger} disabled={!hydrated} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? 'destructive' : 'default'} onClick={() => void confirm()} disabled={pending}>
            {pending && <Spinner />}
            {pending ? pendingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
