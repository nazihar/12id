import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Principal } from '../src/server/middleware'
import { PlatformCallError, platformFor, unwrap } from '../src/server/platform.server'

const token = 'c'.repeat(40)

beforeAll(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:x@127.0.0.1:5432/console_test',
    BETTER_AUTH_URL: 'http://localhost:3600',
    BETTER_AUTH_SECRET: 's'.repeat(40),
    PLATFORM_API_URL: 'http://platform.test',
    CONSOLE_TOKEN: token,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Principals are only minted by the middleware; tests cast to exercise the client alone.
const operator = { actor: 'user_op', role: 'operator', tenantId: null } as unknown as Principal
const member = { actor: 'user_m', role: 'admin', tenantId: '11111111-1111-4111-8111-111111111111' } as unknown as Principal

function captureRequests() {
  const requests: Request[] = []
  vi.stubGlobal('fetch', async (input: Request) => {
    requests.push(input)
    return Response.json([], { status: 200 })
  })
  return requests
}

describe('platformFor', () => {
  it('sends the console scope headers of the principal', async () => {
    const requests = captureRequests()
    await platformFor(operator, { tenantId: '22222222-2222-4222-8222-222222222222' }).GET('/v1/connections')
    const headers = requests[0].headers
    expect(requests[0].url).toBe('http://platform.test/v1/connections')
    expect(headers.get('x-console-token')).toBe(token)
    expect(headers.get('x-console-actor')).toBe('user_op')
    expect(headers.get('x-console-role')).toBe('operator')
    expect(headers.get('x-console-tenant')).toBe('22222222-2222-4222-8222-222222222222')
  })

  it('pins tenant members to their own tenant', async () => {
    const requests = captureRequests()
    await platformFor(member).GET('/v1/connections')
    expect(requests[0].headers.get('x-console-tenant')).toBe('11111111-1111-4111-8111-111111111111')
    expect(() => platformFor(member, { tenantId: '33333333-3333-4333-8333-333333333333' })).toThrow('tenant does not match')
  })
})

describe('unwrap', () => {
  it('returns data or throws the platform reason', () => {
    expect(unwrap({ data: [1], response: new Response(null, { status: 200 }) })).toEqual([1])
    const refused = () => unwrap({ error: { error: 'forbidden', reason: 'API keys are managed from the console' }, response: new Response(null, { status: 403 }) })
    expect(refused).toThrow(PlatformCallError)
    expect(refused).toThrow('API keys are managed from the console')
  })
})
