import { describe, expect, it } from 'vitest'

import { auditRetentionDaysInput, validAuditRetentionDays } from '../src/features/tenant-data/retention.schemas'

describe('audit log period (implement/22 C15)', () => {
  it('is a year to ten years, or 0 to keep everything', () => {
    for (const days of [0, 365, 730, 3650]) expect(validAuditRetentionDays(days)).toBe(true)
    for (const days of [-1, 1, 90, 364, 3651, 365.5, Number.NaN]) expect(validAuditRetentionDays(days)).toBe(false)
  })

  it('the server functions accept the same values, and null for the platform default', () => {
    expect(auditRetentionDaysInput.safeParse(null).success).toBe(true)
    expect(auditRetentionDaysInput.safeParse(730).success).toBe(true)
    expect(auditRetentionDaysInput.safeParse(90).success).toBe(false)
    expect(auditRetentionDaysInput.safeParse('730').success).toBe(false)
  })
})
