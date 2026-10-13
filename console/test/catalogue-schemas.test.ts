/** The publish-schema form refuses what the platform would refuse, on the attributes field. */
import { describe, expect, it } from 'vitest'

import { publishSchemaForm } from '../src/features/portal/catalogue.schemas'

describe('publishSchemaForm', () => {
  it('splits the attributes and drops expiresOn, which the server appends', () => {
    expect(publishSchemaForm.parse({ name: 'badge', version: '1.0', attributes: 'name, memberId\nexpiresOn' }).attributes).toEqual(['name', 'memberId'])
  })

  it('refuses an attribute named id on the attributes field', () => {
    const result = publishSchemaForm.safeParse({ name: 'customer', version: '1.0', attributes: 'id, name' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['attributes'])
    expect(result.error?.issues[0]?.message).toMatch(/named id/)
    expect(publishSchemaForm.safeParse({ name: 'customer', version: '1.0', attributes: 'customerId, Id' }).success).toBe(true)
  })
})
