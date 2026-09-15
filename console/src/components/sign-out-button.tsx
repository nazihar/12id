import { useHydrated, useRouter } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth-client'

export function SignOutButton() {
  const router = useRouter()
  // A click before hydration would do nothing; disabled until the handler is attached.
  const hydrated = useHydrated()
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={!hydrated}
      onClick={async () => {
        await authClient.signOut()
        await router.invalidate()
        await router.navigate({ to: '/login' })
      }}
    >
      Sign out
    </Button>
  )
}
