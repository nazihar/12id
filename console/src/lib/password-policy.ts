/**
 * The console's password rules (implement/24-console-sign-in.md, MTB rows 2.21, 2.29, 2.31). One
 * policy for every account. Client-safe: the forms show these messages as the person types, and the
 * server checks the same function again plus the common-password list (common-passwords.server.ts),
 * which stays out of the client bundle.
 */
export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 128

const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']
const RUN = 4

/** True when `text` holds `RUN` characters in a row from a sequence, either way round (`abcd`, `4321`, `qwer`). */
function hasSequence(text: string): boolean {
  const lower = text.toLowerCase()
  for (const sequence of SEQUENCES) {
    for (const line of [sequence, [...sequence].reverse().join('')]) {
      for (let i = 0; i + RUN <= line.length; i += 1) {
        if (lower.includes(line.slice(i, i + RUN))) return true
      }
    }
  }
  return false
}

/** Parts of the person's own name and address that must not appear in the password (3 characters or more). */
function personalParts(context: { email?: string; name?: string }): string[] {
  const local = (context.email ?? '').split('@')[0] ?? ''
  return [local, ...local.split(/[^a-z0-9]+/i), ...(context.name ?? '').split(/\s+/)]
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 3)
}

/** The rules a password does not meet, as messages for the form. Empty when it is acceptable. */
export function passwordProblems(password: string, context: { email?: string; name?: string } = {}): string[] {
  const problems: string[] = []
  if (password.length < PASSWORD_MIN) problems.push(`Use at least ${PASSWORD_MIN} characters.`)
  if (password.length > PASSWORD_MAX) problems.push(`Use at most ${PASSWORD_MAX} characters.`)
  if (!/[a-z]/.test(password)) problems.push('Add a lowercase letter.')
  if (!/[A-Z]/.test(password)) problems.push('Add an uppercase letter.')
  if (!/[0-9]/.test(password)) problems.push('Add a digit.')
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('Add a symbol, such as ! or #.')
  if (/(.)\1{3}/.test(password)) problems.push('Do not repeat a character four times in a row.')
  if (hasSequence(password)) problems.push('Avoid sequences such as abcd, 1234 or qwer.')
  const lower = password.toLowerCase()
  if (personalParts(context).some((part) => lower.includes(part))) problems.push('Do not use your name or email address.')
  return problems
}

export type PasswordStrength = { score: 0 | 1 | 2 | 3 | 4; label: string }

/** The meter under a new-password field: rules first, then length. */
export function passwordStrength(password: string, context: { email?: string; name?: string } = {}): PasswordStrength {
  if (password.length === 0) return { score: 0, label: '' }
  const problems = passwordProblems(password, context).length
  if (problems > 2) return { score: 0, label: 'Too weak' }
  if (problems > 0) return { score: 1, label: 'Weak' }
  if (password.length >= 20) return { score: 4, label: 'Very strong' }
  if (password.length >= 16) return { score: 3, label: 'Strong' }
  return { score: 2, label: 'Good' }
}
