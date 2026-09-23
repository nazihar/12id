import { describe, expect, it } from 'vitest'

import { contentSecurityPolicy } from '../src/start'

describe('content security policy (review M12)', () => {
  it('runs only scripts with this request nonce, and nothing framed, based or plugged in', () => {
    const policy = contentSecurityPolicy('abc123==')
    expect(policy).toContain("script-src 'nonce-abc123==' 'strict-dynamic'")
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/)
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-eval'/)
    for (const directive of ["default-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "connect-src 'self'"]) expect(policy).toContain(directive)
  })
})
