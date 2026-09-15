import { createFileRoute, useHydrated, useRouter } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { authClient } from '@/lib/auth-client'

const EXPIRED = 'This link has expired or was already used. Ask your operator or organization owner for a new one.'

// Landing page of the emailed link, for a forgotten password and for a new tenant owner's first
// password. Better Auth checks the token and redirects here with ?token= (or ?error=INVALID_TOKEN).
export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>): { token?: string; error?: string } => ({
    token: typeof search.token === 'string' ? search.token : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const { token, error: linkError } = Route.useSearch()
  const router = useRouter()
  const hydrated = useHydrated()
  const [error, setError] = useState<string | null>(linkError || !token ? EXPIRED : null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token) return
    const form = new FormData(event.currentTarget)
    const newPassword = String(form.get('password'))
    if (newPassword !== String(form.get('confirm'))) {
      setError('The passwords do not match.')
      return
    }
    setPending(true)
    setError(null)
    const result = await authClient.resetPassword({ newPassword, token })
    setPending(false)
    if (result.error) {
      setError(result.error.code === 'PASSWORD_TOO_SHORT' ? 'Use at least 12 characters.' : EXPIRED)
      return
    }
    await router.navigate({ to: '/login' })
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Choose your password</CardTitle>
          <CardDescription>After this you sign in and set up two-factor authentication.</CardDescription>
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
                <FieldLabel htmlFor="password">New password</FieldLabel>
                <Input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
                <FieldDescription>At least 12 characters.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="confirm">Repeat the password</FieldLabel>
                <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required />
              </Field>
              <Button type="submit" disabled={!hydrated || pending || !token}>
                Save password
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
