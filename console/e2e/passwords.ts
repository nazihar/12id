/**
 * A password the console's rules accept (implement/24): random consonants and digits between fixed
 * case, digit and symbol characters, so it never spells a common word, and drawn again until the
 * shared policy has nothing to say about it.
 */
import { randomInt } from 'node:crypto'

import { passwordProblems } from '../src/lib/password-policy'

const ALPHABET = 'bcdfghjkmnpqrstvwxzBCDFGHJKMNPQRSTVWXZ23456789'

export function strongPassword(context: { email?: string; name?: string } = {}): string {
  for (;;) {
    const middle = Array.from({ length: 14 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    const candidate = `Q${middle}!z7`
    if (passwordProblems(candidate, context).length === 0) return candidate
  }
}
