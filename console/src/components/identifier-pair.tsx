import { CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A ledger object's two identifier forms (4-init §2.7.2). The unqualified form is the one offers and
 * proof requests carry on the wire; the did:indy form is what the registry returns.
 */
export function IdentifierPair({ unqualified, qualified }: { unqualified: string | null; qualified: string | null }) {
  return (
    <div className="max-w-md space-y-1 font-mono text-xs">
      <CopyableValue label="wire" value={unqualified} />
      <CopyableValue label="did:indy" value={qualified} />
    </div>
  )
}

/** Copies a value to the clipboard and shows that it worked. */
export function CopyButton({ value, label, size = 'icon-xs', variant = 'ghost', children }: { value: string; label: string; size?: 'icon-xs' | 'sm'; variant?: 'ghost' | 'outline'; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {children}
    </Button>
  )
}

/** A value with a copy button; `wrap` shows it in full instead of truncating. */
export function CopyableValue({ label, value, wrap, className }: { label?: string; value: string | null; wrap?: boolean; className?: string }) {
  if (!value) return <div className="text-muted-foreground">{label ? `${label}: —` : '—'}</div>
  return (
    <div className={cn('flex min-w-0 items-center gap-1 font-mono text-xs', className)}>
      {label && <span className="shrink-0 text-muted-foreground">{label}</span>}
      <span className={wrap ? 'break-all' : 'truncate'} title={wrap ? undefined : value}>
        {value}
      </span>
      <CopyButton value={value} label={label ? `Copy the ${label} identifier` : 'Copy'} />
    </div>
  )
}
