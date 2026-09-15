import { createFileRoute, redirect, useHydrated, useRouter } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { authClient } from '@/lib/auth-client'
import { safeRedirect } from '@/lib/redirect'

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({ redirect: safeRedirect(search.redirect) }),
  beforeLoad: ({ context, search }) => {
    if (context.viewer?.twoFactorEnabled) throw redirect({ href: search.redirect ?? '/' })
  },
  component: LoginPage,
})

function LoginPage() {
  const router = useRouter()
  const search = Route.useSearch()
  // Until hydration the form has no handler; a native submit must never send the password anywhere.
  const hydrated = useHydrated()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    const result = await authClient.signIn.email({ email: String(form.get('email')), password: String(form.get('password')) })
    setPending(false)
    if (result.error) {
      // One message for every failure, so the form never reveals whether an account exists.
      setError(result.error.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'Email or password is incorrect.')
      return
    }
    // With 2FA enabled, the two-factor client plugin takes the browser to /verify-2fa itself.
    if (result.data && 'twoFactorRedirect' in result.data && result.data.twoFactorRedirect) return
    await router.invalidate()
    await router.navigate({ href: search.redirect ?? '/' })
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to the 12id Console</CardTitle>
          <CardDescription>Accounts are created by invitation.</CardDescription>
        </CardHeader>
        <CardContent>
          <form method="post" onSubmit={onSubmit}>
            <FieldGroup>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input id="email" name="email" type="email" autoComplete="username" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input id="password" name="password" type="password" autoComplete="current-password" required />
              </Field>
              <Button type="submit" disabled={!hydrated || pending}>
                {pending ? 'Signing in…' : 'Sign in'}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
