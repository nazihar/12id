/** Client-safe schemas for the sign-in, password and account forms. Better Auth validates again on the server. */
import { z } from 'zod'

import { emailAddress, personName } from '@/features/operators/operators.schemas'

export const PASSWORD_MIN = 12
export const password = z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`).max(128, 'Use at most 128 characters.')

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
  if (value.confirm !== value.password) ctx.addIssue({ code: 'custom', path: ['confirm'], message: 'The passwords do not match.' })
})
export type InvitedAccountForm = z.input<typeof invitedAccountForm>
