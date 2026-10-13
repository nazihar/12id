import { Link, createFileRoute, useHydrated, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { useCaptcha } from '@/components/captcha'
import { Form, formValidation, useAppForm } from '@/components/form/form'
import { AuthLayout } from '@/components/shell/auth-layout'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { createInvitedAccount, getInvitationPreview } from '@/features/invitations/invitation.functions'
import { type InvitedAccountForm, invitedAccountForm } from '@/features/session/auth.schemas'
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

  if (!invitation) {
    return <AuthLayout size="md" title="This invitation is no longer valid" description="It has expired, was cancelled or was already accepted. Ask the organization owner to invite you again." />
  }

  return (
    <AuthLayout
      size="md"
      title={`Join ${invitation.organizationName}`}
      description={
        <>
          You are invited as <strong>{invitation.role}</strong> with {invitation.email}.
        </>
      }
    >
      {viewer ? (
        viewer.email.toLowerCase() === invitation.email ? (
          <AcceptInvitation invitationId={invitationId} />
        ) : (
          <SignedInAsSomeoneElse email={viewer.email} invitedEmail={invitation.email} />
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
    </AuthLayout>
  )
}

function SignedInAsSomeoneElse({ email, invitedEmail }: { email: string; invitedEmail: string }) {
  const router = useRouter()
  const hydrated = useHydrated()
  return (
    <div className="space-y-3 text-sm">
      <p>
        You are signed in as {email}. Sign out and sign in as {invitedEmail} to accept.
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={!hydrated}
        onClick={async () => {
          await authClient.signOut()
          await router.invalidate()
        }}
      >
        Sign out
      </Button>
    </div>
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
  const [error, setError] = useState<string | null>(null)
  // The sign-in right after the account is made goes through the same check as the login page.
  const { captcha, take } = useCaptcha()

  const form = useAppForm({
    defaultValues: { name: '', password: '', confirm: '' } satisfies InvitedAccountForm,
    validationLogic: formValidation,
    validators: { onDynamic: invitedAccountForm },
    onSubmit: async ({ value }) => {
      setError(null)
      try {
        await createInvitedAccount({ data: { invitationId, name: value.name, password: value.password } })
        const proof = await take()
        const signIn = await authClient.signIn.email({ email, password: value.password, rememberMe: false }, { headers: { 'x-captcha': proof ?? '' } })
        if (signIn.error) throw new Error('Your account was created, but signing in failed. Sign in from the login page.')
        const accepted = await authClient.organization.acceptInvitation({ invitationId })
        if (accepted.error) throw new Error(accepted.error.message ?? 'The invitation could not be accepted.')
        await router.invalidate()
        // Sets up two-factor authentication next, then opens the organization.
        await router.navigate({ to: '/' })
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Something went wrong.')
      }
    },
  })

  return (
    <Form form={form}>
      <form.FormError error={error} />
      <form.AppField name="name">{(field) => <field.TextField label="Your name" autoComplete="name" autoFocus />}</form.AppField>
      <form.AppField name="password">{(field) => <field.NewPasswordField label="Password" person={{ email }} description="Two-factor authentication is set up next." />}</form.AppField>
      <form.AppField name="confirm">{(field) => <field.PasswordField label="Repeat the password" autoComplete="new-password" />}</form.AppField>
      {captcha}
      <form.SubmitButton pendingLabel="Creating your account…">Create account and join</form.SubmitButton>
    </Form>
  )
}
