import { CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'

/**
 * A ledger object's two identifier forms (4-init §2.7.2). The unqualified form is the one offers and
 * proof requests carry on the wire; the did:indy form is what the registry returns.
 */
export function IdentifierPair({ unqualified, qualified }: { unqualified: string | null; qualified: string | null }) {
  return (
    <div className="max-w-md space-y-1 font-mono text-xs">
      <CopyableId label="wire" value={unqualified} />
      <CopyableId label="did:indy" value={qualified} />
    </div>
  )
}

function CopyableId({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false)
  if (!value) return <div className="text-muted-foreground">{label}: —</div>
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate" title={value}>
        {value}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Copy the ${label} identifier`}
        onClick={async () => {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  )
}
