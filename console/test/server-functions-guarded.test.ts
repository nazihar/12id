/**
 * The data-boundary rule (plan C2): every server function is guarded by `operatorMiddleware` or
 * `tenantMiddleware(...)`. Route guards are UX only, so an unguarded `createServerFn` is an open
 * endpoint. A function that must work without a session (invitation acceptance, for example) is
 * listed in PUBLIC_SERVER_FUNCTIONS with the reason it is safe.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../src', import.meta.url))

/** `path/from/src.functions.ts#exportName` → why it may run without a console session. */
const PUBLIC_SERVER_FUNCTIONS = new Map<string, string>([
  ['features/session/session.functions.ts#getViewer', "returns only the caller's own identity (null when anonymous) for route guards; no tenant data"],
  ['features/session/session.functions.ts#getShellPreferences', "reads only the caller's own sidebar cookie; no account or tenant data"],
  ['features/invitations/invitation.functions.ts#getInvitationPreview', 'needs the unguessable invitation id from the invited mailbox; returns only what that mail says'],
  ['features/invitations/invitation.functions.ts#createInvitedAccount', 'the invitee has no account yet; acts only on a pending, unexpired invitation whose email has no account'],
])

/** Functions that need a signed-in user but no tenant: they only touch the caller's own memberships. */
const SESSION_SERVER_FUNCTIONS = new Map<string, string>([
  ['features/portal/portal-session.functions.ts#listMyOrganizations', "lists the caller's own memberships"],
  ['features/portal/portal-session.functions.ts#activateOrganization', 'switches among the caller\'s own memberships; refuses any other organization'],
])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

const key = (file: string, name: string) => `${relative(root, file).replaceAll('\\', '/')}#${name}`

describe('server functions', () => {
  const files = sourceFiles(root)

  it('are declared only in .functions.ts files', () => {
    const misplaced = files.filter((file) => !file.endsWith('.functions.ts') && readFileSync(file, 'utf8').includes('createServerFn('))
    expect(misplaced.map((file) => relative(root, file))).toEqual([])
  })

  it('each carry operatorMiddleware or tenantMiddleware', () => {
    const unguarded: string[] = []
    let declarations = 0
    let calls = 0
    for (const file of files.filter((f) => f.endsWith('.functions.ts'))) {
      const text = readFileSync(file, 'utf8')
      calls += text.split('createServerFn(').length - 1
      for (const match of text.matchAll(/export const (\w+) = createServerFn\([^)]*\)([\s\S]*?)\.handler\(/g)) {
        declarations += 1
        const [, name, chain] = match
        if (PUBLIC_SERVER_FUNCTIONS.has(key(file, name))) continue
        if (SESSION_SERVER_FUNCTIONS.has(key(file, name))) {
          if (!/\.middleware\(\[\s*authMiddleware\b/.test(chain)) unguarded.push(key(file, name))
          continue
        }
        if (!/\.middleware\(\[\s*(operatorMiddleware|tenantMiddleware\()/.test(chain)) unguarded.push(key(file, name))
      }
    }
    expect(unguarded).toEqual([])
    // Every createServerFn must match the declaration shape above, or the check would skip it.
    expect(declarations).toBe(calls)
    expect(declarations).toBeGreaterThan(0)
  })
})
