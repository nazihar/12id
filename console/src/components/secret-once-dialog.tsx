import { CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** Shows a secret exactly once (API key, webhook signing secret). Closing the dialog discards it. */
export function SecretOnceDialog({ secret, title, description, onClose }: { secret: string | null; title: string; description: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const close = () => {
    setCopied(false)
    onClose()
  }

  return (
    <Dialog open={secret !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <code className="rounded-md bg-muted px-2 py-2 font-mono text-xs break-all" data-testid="secret-value">
          {secret}
        </code>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              if (!secret) return
              await navigator.clipboard.writeText(secret)
              setCopied(true)
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button onClick={close}>I have stored it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
