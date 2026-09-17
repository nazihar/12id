import type { ErrorComponentProps } from '@tanstack/react-router'
import { CircleAlertIcon } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

/** Error view for data pages. Messages come from platform-api or the console middleware, both customer-safe. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>This page could not be loaded</AlertTitle>
      <AlertDescription className="gap-3">
        <span>{error instanceof Error ? error.message : 'Unexpected error.'}</span>
        <div>
          <Button size="sm" variant="outline" onClick={reset}>
            Try again
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
