import { describe, expect, it } from 'vitest'

import { duration, healthSummary, severityLevel } from '../src/features/ops/health-format'

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 12, 6, 0) + minutes * 60_000).toISOString()

describe('system health wording (implement/22 C16)', () => {
  it('says how long, in the largest two units', () => {
    expect(duration(at(0), at(0))).toBe('under a minute')
    expect(duration(at(0), at(42))).toBe('42 min')
    expect(duration(at(0), at(120))).toBe('2 h')
    expect(duration(at(0), at(185))).toBe('3 h 5 min')
    expect(duration(at(0), at(48 * 60))).toBe('2 d')
    expect(duration(at(0), at(52 * 60 + 10))).toBe('2 d 4 h')
    // A clock that disagrees never yields a negative duration.
    expect(duration(at(10), at(0))).toBe('under a minute')
  })

  it('reads an unknown severity as a warning', () => {
    expect(severityLevel('critical')).toBe('critical')
    expect(severityLevel('warning')).toBe('warning')
    expect(severityLevel(null)).toBe('warning')
  })

  it('puts the worst thing first', () => {
    const base = { ready: true, draining: false, checks: { database: true, agent: true }, monitoring: { connected: true, silent: false }, alerts: { firing: [] as Array<{ severity: string | null }> } }
    expect(healthSummary(base)).toEqual({ level: 'good', text: 'Everything answers and no alert is firing.' })
    expect(healthSummary({ ...base, alerts: { firing: [{ severity: 'warning' }] } })).toEqual({ level: 'warning', text: '1 alert firing.' })
    expect(healthSummary({ ...base, alerts: { firing: [{ severity: 'warning' }, { severity: 'critical' }] } })).toEqual({ level: 'critical', text: '2 alerts firing, 1 of them critical.' })
    // A failing check outranks an alert: it is what platform-api itself cannot reach right now.
    expect(healthSummary({ ...base, checks: { database: true, agent: false }, alerts: { firing: [{ severity: 'critical' }] } })).toEqual({ level: 'critical', text: 'Agent service is not answering.' })
    expect(healthSummary({ ...base, monitoring: { connected: false, silent: true } }).text).toContain('Monitoring is not connected')
    expect(healthSummary({ ...base, monitoring: { connected: true, silent: true } }).text).toContain('stopped reporting')
    expect(healthSummary({ ...base, draining: true }).level).toBe('warning')
  })
})
