import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { credentialValuesSchema } from '../src/credential-values.ts'

const ok = (values: Record<string, string>) => credentialValuesSchema.safeParse(values).success

describe('credential values bounds (review L4)', () => {
  it('accepts an ordinary offer and the edges of every bound', () => {
    assert.ok(ok({ name: 'Alice', expiresAt: '1893456000' }))
    assert.ok(ok({ ['n'.repeat(100)]: 'v'.repeat(4096) }))
    assert.ok(ok(Object.fromEntries(Array.from({ length: 125 }, (_, i) => [`a${i}`, 'x'.repeat(400)]))))
  })

  it('refuses too many attributes, long names, large values and a large total', () => {
    assert.ok(!ok(Object.fromEntries(Array.from({ length: 126 }, (_, i) => [`a${i}`, 'x']))))
    assert.ok(!ok({ ['n'.repeat(101)]: 'v' }))
    assert.ok(!ok({ '': 'v' }))
    assert.ok(!ok({ big: 'v'.repeat(4097) }))
    // 4 KB counts bytes, not characters: 1,366 three-byte characters are 4,098 bytes.
    assert.ok(!ok({ wide: '€'.repeat(1366) }))
    assert.ok(!ok(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`a${i}`, 'x'.repeat(4000)]))))
  })
})
