import { useHydrated } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

import { ConfirmDialog, type ConfirmDialogProps } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface RowActionProps {
  /** Shown in the tooltip and as the button's accessible name, so tests can still find it by name. */
  label: string
  icon: LucideIcon
  variant?: ComponentProps<typeof Button>['variant']
  disabled?: boolean
  onClick?: () => void
  /** When set, the click opens the confirmation dialog and the action runs on confirm. */
  confirm?: Omit<ConfirmDialogProps, 'trigger'>
}

/** An icon button for a table row: label in a tooltip, optional confirmation step. */
export function RowAction({ label, icon: Icon, variant = 'ghost', disabled, onClick, confirm }: RowActionProps) {
  const hydrated = useHydrated()
  const button = (
    <Button size="icon-sm" variant={variant} aria-label={label} disabled={disabled || !hydrated} onClick={confirm ? undefined : onClick}>
      <Icon />
    </Button>
  )
  return (
    <Tooltip>
      {confirm ? <ConfirmDialog trigger={<TooltipTrigger render={button} />} {...confirm} /> : <TooltipTrigger render={button} />}
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Keeps a row's actions on one line and right-aligned. */
export function RowActions({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-0.5">{children}</div>
}
