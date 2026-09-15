import type { ErrorComponentProps } from '@tanstack/react-router'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/** Error view for data pages. Messages come from platform-api or the console middleware, both customer-safe. */
export function RouteError({ error }: ErrorComponentProps) {
  return (
    <Alert variant="destructive">
      <AlertTitle>This page could not be loaded</AlertTitle>
      <AlertDescription>{error instanceof Error ? error.message : 'Unexpected error.'}</AlertDescription>
    </Alert>
  )
}
