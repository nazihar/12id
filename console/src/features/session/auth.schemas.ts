/** Client-safe schemas for the sign-in, password and account forms. Better Auth validates again on the server. */
import { z } from 'zod'

import { emailAddress, personName } from '@/features/operators/operators.schemas'
import { PASSWORD_MIN, passwordProblems } from '@/lib/password-policy'

export { PASSWORD_MIN }
/** A new password: the shared rules (implement/24). The server also checks common words and the last three passwords. */
export const password = z.string().superRefine((value, ctx) => {
  for (const message of passwordProblems(value)) ctx.addIssue({ code: 'custom', message })
})

export const signInForm = z.object({ email: emailAddress, password: z.string().min(1, 'Enter your password.') })
export type SignInFormValues = z.input<typeof signInForm>

export const forgotPasswordForm = z.object({ email: emailAddress })
export type ForgotPasswordForm = z.input<typeof forgotPasswordForm>
export type SignInForm = z.input<typeof signInForm>

export const passwordConfirmForm = z.object({ password, confirm: z.string() }).superRefine((value, ctx) => {
  if (value.confirm !== value.password) ctx.addIssue({ code: 'custom', path: ['confirm'], message: 'The passwords do not match.' })
})
export type PasswordConfirmForm = z.input<typeof passwordConfirmForm>

export const confirmPasswordForm = z.object({ password: z.string().min(1, 'Enter your password.') })

export const invitedAccountForm = z.object({ name: personName, password, confirm: z.string() }).superRefine((value, ctx) => {
  if (passwordProblems(value.password, { name: value.name }).some((message) => message.includes('your name'))) {
    ctx.addIssue({ code: 'custom', path: ['password'], message: 'Do not use your name or email address.' })
  }
  if (value.confirm !== value.password) ctx.addIssue({ code: 'custom', path: ['confirm'], message: 'The passwords do not match.' })
})
export type InvitedAccountForm = z.input<typeof invitedAccountForm>

/** The Change password page (implement/24): the current password, a new one twice. */
export const changePasswordForm = z
  .object({ currentPassword: z.string().min(1, 'Enter your current password.'), password, confirm: z.string() })
  .superRefine((value, ctx) => {
    if (value.confirm !== value.password) ctx.addIssue({ code: 'custom', path: ['confirm'], message: 'The passwords do not match.' })
    if (value.password && value.password === value.currentPassword) ctx.addIssue({ code: 'custom', path: ['password'], message: 'Choose a password you have not used before.' })
  })
export type ChangePasswordForm = z.input<typeof changePasswordForm>
