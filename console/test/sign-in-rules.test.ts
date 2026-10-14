/** The console's sign-in rules (implement/24-console-sign-in.md): password policy, timers, lock, captcha. */
import { solveChallenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'
import { beforeAll, describe, expect, it } from 'vitest'

import { passwordProblems, passwordStrength } from '../src/lib/password-policy'
import { accountInactive, accountLocked, accountState, afterWrongPassword, membershipDisabled, passwordExpired, sessionIdle, signInDelayMs } from '../src/lib/sign-in-rules'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const now = Date.UTC(2026, 9, 13, 12, 0, 0)

describe('password policy (MTB 2.21, 2.29)', () => {
  it('accepts a long password with every kind of character and no pattern', () => {
    expect(passwordProblems('Tr0mbone!Velvet', { email: 'ada@example.com', name: 'Ada Lovelace' })).toEqual([])
  })

  it('names every rule a weak password misses', () => {
    expect(passwordProblems('short')).toEqual(['Use at least 12 characters.', 'Add an uppercase letter.', 'Add a digit.', 'Add a symbol, such as ! or #.'])
    expect(passwordProblems('ALLUPPERCASE12!')).toContain('Add a lowercase letter.')
  })

  it('refuses sequences and repeats either way round, and keyboard rows', () => {
    expect(passwordProblems('Xyzabcd!9Qrt')).toContain('Avoid sequences such as abcd, 1234 or qwer.')
    expect(passwordProblems('Pq!x9876Lmnz')).toContain('Avoid sequences such as abcd, 1234 or qwer.')
    expect(passwordProblems('Qwerty!7Lmnz')).toContain('Avoid sequences such as abcd, 1234 or qwer.')
    expect(passwordProblems('Bzzzz!7Lmnqp')).toContain('Do not repeat a character four times in a row.')
  })

  it("refuses the person's own name and address", () => {
    expect(passwordProblems('Lovelace!9Tq#', { name: 'Ada Lovelace' })).toContain('Do not use your name or email address.')
    expect(passwordProblems('Xq!9ada.king#', { email: 'ada.king@example.com' })).toContain('Do not use your name or email address.')
  })

  it('scores the meter: rules first, then length', () => {
    expect(passwordStrength('').score).toBe(0)
    expect(passwordStrength('short').score).toBe(0)
    expect(passwordStrength('Tr0mbonevelvet').score).toBe(1)
    expect(passwordStrength('Tr0mbone!Velvet').score).toBe(2)
    expect(passwordStrength('Tr0mbone!Velvet#Hq').score).toBe(3)
    expect(passwordStrength('Tr0mbone!Velvet#Harp7').score).toBe(4)
  })
})

describe('timers and the lock', () => {
  it('ends a session idle past the limit, counting from creation when it never recorded activity (MTB 2.25)', () => {
    expect(sessionIdle(new Date(now - 14 * MINUTE), new Date(now - 60 * MINUTE), 15, now)).toBe(false)
    expect(sessionIdle(new Date(now - 16 * MINUTE), new Date(now - 60 * MINUTE), 15, now)).toBe(true)
    expect(sessionIdle(null, new Date(now - 16 * MINUTE), 15, now)).toBe(true)
  })

  it('expires a password after its age, and never when the rule is off (MTB 2.34)', () => {
    expect(passwordExpired(new Date(now - 91 * DAY), 90, now)).toBe(true)
    expect(passwordExpired(new Date(now - 89 * DAY), 90, now)).toBe(false)
    expect(passwordExpired(new Date(now - 900 * DAY), 0, now)).toBe(false)
  })

  it('locks at the threshold and then counts again; the delay grows to 5 s (MTB 2.26, 2.36)', () => {
    expect(afterWrongPassword(3, 5, 15, now)).toEqual({ failures: 4, lockedUntil: null })
    expect(afterWrongPassword(4, 5, 15, now)).toEqual({ failures: 0, lockedUntil: new Date(now + 15 * MINUTE) })
    expect(accountLocked(new Date(now + MINUTE), now)).toBe(true)
    expect(accountLocked(new Date(now - MINUTE), now)).toBe(false)
    expect([0, 1, 3, 9].map(signInDelayMs)).toEqual([0, 1000, 3000, 5000])
  })

  it('finds unused accounts, counting from creation when they never signed in (MTB 2.28)', () => {
    expect(accountInactive(new Date(now - 91 * DAY), new Date(now - 400 * DAY), 90, now)).toBe(true)
    expect(accountInactive(null, new Date(now - 10 * DAY), 90, now)).toBe(false)
    expect(accountInactive(null, new Date(now - 91 * DAY), 0, now)).toBe(false)
  })

  it('names one state per account for the lists', () => {
    expect(accountState({ banned: true, banReason: 'inactive: no sign-in for 90 days' })).toBe('inactive')
    expect(accountState({ banned: true, banReason: 'left the company' })).toBe('disabled')
    expect(accountState({ lockedUntil: new Date(now + MINUTE) }, now)).toBe('locked')
    expect(accountState({}, now)).toBe('active')
  })
})

describe('server checks', () => {
  beforeAll(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://postgres:x@127.0.0.1:5432/console',
      BETTER_AUTH_URL: 'https://12id.example',
      BETTER_AUTH_SECRET: 's'.repeat(40),
      PLATFORM_API_URL: 'http://platform-api:3500',
      CONSOLE_TOKEN: 'c'.repeat(40),
    })
  })

  it('finds common words, also with look-alike characters and inside a longer run', async () => {
    const { commonWordIn, serverPasswordProblems } = await import('../src/server/sign-in-rules.server')
    expect(commonWordIn('P@ssw0rd!2026')).toBe('password')
    expect(commonWordIn('MyP@ssword#77')).not.toBeNull()
    expect(commonWordIn('Welcome#2026')).toBe('welcome')
    expect(commonWordIn('Quillon7!Mosaic#Brim')).toBeNull()
    expect(serverPasswordProblems('P@ssw0rd!2026', {})).toContain('Avoid common words and passwords, also with letters swapped for digits or symbols.')
  })

  it('accepts a solved captcha once, and nothing else (MTB 2.32)', async () => {
    const { captchaChallenge, captchaSolved } = await import('../src/server/captcha.server')
    const challenge = await captchaChallenge()
    const solution = await solveChallenge({ challenge, deriveKey })
    expect(solution).not.toBeNull()
    const payload = btoa(JSON.stringify({ challenge, solution }))
    expect(await captchaSolved(payload)).toBe(true)
    expect(await captchaSolved(payload)).toBe(false)
    expect(await captchaSolved(null)).toBe(false)
    expect(await captchaSolved('not a payload')).toBe(false)
    const forged = btoa(JSON.stringify({ challenge: { ...challenge, parameters: { ...challenge.parameters, cost: 1 } }, solution }))
    expect(await captchaSolved(forged)).toBe(false)
  }, 30_000)
})

describe('disable with a period (implement/26)', () => {
  const now = Date.parse('2026-10-13T12:00:00Z')
  const HOUR = 60 * 60 * 1000

  it('reads a disable that has run out as active, and one still running as disabled', () => {
    expect(accountState({ banned: true, banReason: 'on leave', banExpires: new Date(now + HOUR) }, now)).toBe('disabled')
    expect(accountState({ banned: true, banReason: 'on leave', banExpires: new Date(now - HOUR) }, now)).toBe('active')
    expect(accountState({ banned: true, banReason: 'left', banExpires: null }, now)).toBe('disabled')
  })

  it('holds a membership disable until its date, or for good without one', () => {
    expect(membershipDisabled({}, now)).toBe(false)
    expect(membershipDisabled({ disabledAt: new Date(now - HOUR) }, now)).toBe(true)
    expect(membershipDisabled({ disabledAt: new Date(now - HOUR), disabledUntil: new Date(now + HOUR) }, now)).toBe(true)
    expect(membershipDisabled({ disabledAt: new Date(now - 2 * HOUR), disabledUntil: new Date(now - HOUR) }, now)).toBe(false)
  })
})
