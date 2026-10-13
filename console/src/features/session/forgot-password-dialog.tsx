import { useState } from 'react'

import { useCaptcha } from '@/components/captcha'
import { Form, formValidation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { type ForgotPasswordForm, forgotPasswordForm } from '@/features/session/auth.schemas'
import { authClient } from '@/lib/auth-client'

/**
 * Sends the "choose a password" link (the same mail an operator's or owner's first password uses).
 * The answer never says whether the address has an account, so the dialog cannot be used to find out
 * who is registered. Better Auth allows three of these per minute per address.
 */
export function ForgotPasswordDialog() {
  const [sent, setSent] = useState(false)
  return (
    <FormDialog
      trigger={
        <Button type="button" variant="link" size="sm" className="px-0">
          Forgot your password?
        </Button>
      }
      title="Reset your password"
      description="We email a link that lets you choose a new password. It works once and expires in 10 minutes."
      onOpenChange={(open) => !open && setSent(false)}
    >
      {({ close }) => (sent ? <Sent onDone={close} /> : <RequestForm onSent={() => setSent(true)} />)}
    </FormDialog>
  )
}

function RequestForm({ onSent }: { onSent: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const { captcha, take } = useCaptcha()
  const form = useAppForm({
    defaultValues: { email: '' } satisfies ForgotPasswordForm,
    validationLogic: formValidation,
    validators: { onDynamic: forgotPasswordForm },
    onSubmit: async ({ value }) => {
      setError(null)
      const proof = await take()
      if (!proof) {
        setError('The check that you are not a robot did not finish. Reload the page and try again.')
        return
      }
      const result = await authClient.requestPasswordReset({ email: forgotPasswordForm.parse(value).email, redirectTo: '/reset-password' }, { headers: { 'x-captcha': proof } })
      // A refusal for an unknown address is not reported: the page must not reveal who has an account.
      if (result.error && result.error.status === 429) {
        setError('Too many requests. Wait a minute and try again.')
        return
      }
      if (result.error?.code === 'CAPTCHA_REQUIRED') {
        setError(result.error.message ?? 'The check did not complete. Try again.')
        return
      }
      onSent()
    },
  })
  return (
    <Form form={form}>
      <form.FormError error={error} />
      <form.AppField name="email">{(field) => <field.TextField label="Email" type="email" autoComplete="username" autoFocus />}</form.AppField>
      {captcha}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Sending…">Email me a link</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}

function Sent({ onDone }: { onDone: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <AlertDescription>If that address has an account, the link is on its way. Check the spam folder if it does not arrive within a few minutes.</AlertDescription>
      </Alert>
      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </div>
  )
}
