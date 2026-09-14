import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PlatformError } from '../src/http/errors.ts'
import { expandTemplate, templateDefinition, validateTemplate } from '../src/templates.ts'
import { sampleCatalogue } from './helpers.ts'

const parse = (definition: unknown) => templateDefinition.parse(definition)
const is400 = (e: unknown) => e instanceof PlatformError && e.status === 400

describe('proof templates', () => {
  it('expands a schema name across all versions, including deprecated ones', () => {
    const groups = expandTemplate(parse({ name: 'badge', groups: [{ key: 'employee', attributes: ['name'], credentials: [{ schemaName: 'employee-badge' }] }] }), sampleCatalogue)
    assert.deepEqual(groups[0].credentialDefinitionIds.sort(), ['ABC:3:CL:10:default', 'ABC:3:CL:12:default'])
  })

  it('restricts to active versions when asked', () => {
    const groups = expandTemplate(parse({ name: 'badge', groups: [{ key: 'employee', attributes: ['name'], credentials: [{ schemaName: 'employee-badge', versions: 'active' }] }] }), sampleCatalogue)
    assert.deepEqual(groups[0].credentialDefinitionIds, ['ABC:3:CL:12:default'])
  })

  it('accepts an explicit credential definition by catalogue id or ledger id, deduplicated', () => {
    const groups = expandTemplate(parse({ name: 'v', groups: [{ key: 'g', attributes: ['name'], credentials: [{ credentialDefinitionId: 'cd-3' }, { credentialDefinitionId: 'ABC:3:CL:14:default' }] }] }), sampleCatalogue)
    assert.deepEqual(groups[0].credentialDefinitionIds, ['ABC:3:CL:14:default'])
  })

  it('refuses unknown references with a 400', () => {
    assert.throws(() => expandTemplate(parse({ name: 'v', groups: [{ key: 'g', attributes: ['name'], credentials: [{ schemaName: 'nope' }] }] }), sampleCatalogue), is400)
    assert.throws(() => expandTemplate(parse({ name: 'v', groups: [{ key: 'g', attributes: ['name'], credentials: [{ credentialDefinitionId: 'missing' }] }] }), sampleCatalogue), is400)
  })

  it('refuses expiresAt in attributes or predicates, attributes both revealed and predicated, empty groups and duplicate keys', () => {
    const reject = (definition: unknown, pattern: RegExp) => assert.throws(() => validateTemplate(parse(definition)), pattern)
    reject({ name: 'v', groups: [{ key: 'g', attributes: ['expiresAt'], credentials: [{ schemaName: 'x' }] }] }, /expiresAt cannot be disclosed/)
    reject({ name: 'v', groups: [{ key: 'g', attributes: [], predicates: [{ name: 'expiresAt', type: '>=', value: 1 }], credentials: [{ schemaName: 'x' }] }] }, /predicated automatically/)
    reject({ name: 'v', groups: [{ key: 'g', attributes: ['age'], predicates: [{ name: 'age', type: '>=', value: 18 }], credentials: [{ schemaName: 'x' }] }] }, /both disclosed and predicated/)
    reject({ name: 'v', groups: [{ key: 'g', attributes: [], credentials: [{ schemaName: 'x' }] }] }, /nothing to disclose/)
    reject({ name: 'v', groups: [{ key: 'g', attributes: ['a'], credentials: [{ schemaName: 'x' }] }, { key: 'g', attributes: ['b'], credentials: [{ schemaName: 'x' }] }] }, /unique/)
  })
})
