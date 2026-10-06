/** The builder's schema places every cross-field rule on the field it concerns (form kit, C7). */
import { describe, expect, it } from 'vitest'

import { templateDefinitionForm, templateDefinitionInput, templateProblems } from '../src/lib/template-schema'

const group = (key: string, extra: Partial<{ attributes: string[]; predicates: { name: string; type: '>=' | '>' | '<=' | '<'; value: number }[] }> = {}) => ({
  key,
  credentials: [{ schemaName: 'badge', versions: 'all' as const }],
  attributes: ['name'],
  predicates: [],
  ...extra,
})

const paths = (result: ReturnType<typeof templateDefinitionForm.safeParse>) => (result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`))

describe('template rules', () => {
  it('accept a valid template', () => {
    expect(templateDefinitionForm.safeParse({ name: 'ok', groups: [group('a')] }).success).toBe(true)
    expect(templateProblems({ name: 'ok', groups: [group('a')] })).toEqual([])
  })

  it('name duplicate keys on the second group', () => {
    expect(paths(templateDefinitionForm.safeParse({ name: 'x', groups: [group('a'), group('a')] }))).toEqual(['groups.1.key: Group keys must be unique; "a" is also group 1.'])
  })

  it('refuse expiresOn as disclosed or predicated, on those fields', () => {
    const issues = paths(templateDefinitionForm.safeParse({ name: 'x', groups: [group('a', { attributes: ['expiresOn'], predicates: [{ name: 'expiresOn', type: '>=', value: 1 }] })] }))
    expect(issues).toContain('groups.0.attributes: expiresOn cannot be disclosed; it is always checked.')
    expect(issues).toContain('groups.0.predicates.0.name: expiresOn is checked automatically.')
  })

  it('refuse an attribute both disclosed and predicated, on the predicate', () => {
    expect(paths(templateDefinitionForm.safeParse({ name: 'x', groups: [group('a', { attributes: ['age'], predicates: [{ name: 'age', type: '>=', value: 18 }] })] }))).toEqual([
      'groups.0.predicates.0.name: age is already disclosed; an attribute cannot be both disclosed and predicated.',
    ])
  })

  it('require an attribute or a predicate per group, and a whole number', () => {
    expect(paths(templateDefinitionForm.safeParse({ name: 'x', groups: [group('a', { attributes: [] })] }))).toEqual(['groups.0.attributes: Disclose at least one attribute or add a predicate.'])
    expect(paths(templateDefinitionForm.safeParse({ name: 'x', groups: [group('a', { attributes: [], predicates: [{ name: 'age', type: '>=', value: Number.NaN }] })] }))).toEqual(['groups.0.predicates.0.value: Enter a whole number.'])
  })

  it('apply the same rules to the server shape, where arrays may be absent', () => {
    expect(templateDefinitionInput.safeParse({ name: 'x', groups: [{ key: 'a', credentials: [{ schemaName: 'badge' }] }] }).success).toBe(false)
    expect(templateDefinitionInput.safeParse({ name: 'x', groups: [{ key: 'a', credentials: [{ schemaName: 'badge' }], predicates: [{ name: 'age', type: '>=', value: 18 }] }] }).success).toBe(true)
  })
})
