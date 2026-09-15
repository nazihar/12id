import { Link, createFileRoute, useHydrated, useRouter } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { SignOutButton } from '@/components/sign-out-button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { createInvitedAccount, getInvitationPreview } from '@/features/invitations/invitation.functions'
import { authClient } from '@/lib/auth-client'

// Landing page of an organization invitation email.
export const Route = createFileRoute('/invite/$invitationId')({
  loader: ({ params }) => getInvitationPreview({ data: { invitationId: params.invitationId } }),
  component: InvitationPage,
})

function InvitationPage() {
  const invitation = Route.useLoaderData()
  const { invitationId } = Route.useParams()
  const { viewer } = Route.useRouteContext()

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        {!invitation ? (
          <CardHeader>
            <CardTitle>This invitation is no longer valid</CardTitle>
            <CardDescription>It has expired, was cancelled or was already accepted. Ask the organization owner to invite you again.</CardDescription>
          </CardHeader>
        ) : (
          <>
            <CardHeader>
              <CardTitle>Join {invitation.organizationName}</CardTitle>
              <CardDescription>
                You are invited as <strong>{invitation.role}</strong> with {invitation.email}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {viewer ? (
                viewer.email.toLowerCase() === invitation.email ? (
                  <AcceptInvitation invitationId={invitationId} />
                ) : (
                  <div className="space-y-3 text-sm">
                    <p>You are signed in as {viewer.email}. Sign out and sign in as {invitation.email} to accept.</p>
                    <SignOutButton />
                  </div>
                )
              ) : invitation.accountExists ? (
                <div className="space-y-3 text-sm">
                  <p>You already have an account. Sign in, then open this invitation link again.</p>
                  <Link to="/login" search={{ redirect: `/invite/${invitationId}` }} className={buttonVariants()}>
                    Sign in
                  </Link>
                </div>
              ) : (
                <CreateAccount invitationId={invitationId} email={invitation.email} />
              )}
            </CardContent>
          </>
        )}
      </Card>
    </main>
  )
}

function AcceptInvitation({ invitationId }: { invitationId: string }) {
  const router = useRouter()
  const hydrated = useHydrated()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function accept() {
    setPending(true)
    setError(null)
    const result = await authClient.organization.acceptInvitation({ invitationId })
    setPending(false)
    if (result.error) {
      setError(result.error.message ?? 'The invitation could not be accepted.')
      return
    }
    await router.invalidate()
    await router.navigate({ to: '/' })
  }

  return (
    <div className="space-y-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button onClick={accept} disabled={!hydrated || pending}>
        Accept invitation
      </Button>
    </div>
  )
}

function CreateAccount({ invitationId, email }: { invitationId: string; email: string }) {
  const router = useRouter()
  const hydrated = useHydrated()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password'))
    if (password !== String(form.get('confirm'))) {
      setError('The passwords do not match.')
      return
    }
    setPending(true)
    setError(null)
    try {
      await createInvitedAccount({ data: { invitationId, name: String(form.get('name')), password } })
      const signIn = await authClient.signIn.email({ email, password })
      if (signIn.error) throw new Error('Your account was created, but signing in failed. Sign in from the login page.')
      const accepted = await authClient.organization.acceptInvitation({ invitationId })
      if (accepted.error) throw new Error(accepted.error.message ?? 'The invitation could not be accepted.')
      await router.invalidate()
      // Sets up two-factor authentication next, then opens the organization.
      await router.navigate({ to: '/' })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.')
      setPending(false)
    }
  }

  return (
    <form method="post" onSubmit={onSubmit}>
      <FieldGroup>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="name">Your name</FieldLabel>
          <Input id="name" name="name" autoComplete="name" maxLength={200} required />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
          <FieldDescription>At least 12 characters. Two-factor authentication is set up next.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="confirm">Repeat the password</FieldLabel>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required />
        </Field>
        <Button type="submit" disabled={!hydrated || pending}>
          {pending ? 'Creating your account…' : 'Create account and join'}
        </Button>
      </FieldGroup>
    </form>
  )
}
