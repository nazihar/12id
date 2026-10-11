/**
 * Conditional gate, the checks that create no exchange (and so need no webhook receiver and no
 * holder): a template takes a rule from the console scope, the API key reads it back, a credential
 * definition refuses one, and a proof request that lacks a number the rule names is refused before
 * anything is sent. The full flow is step 5 of smoke:biometric-credo.
 *
 * Env as smoke:biometric-credo: PLATFORM_API, PLATFORM_API_KEY, PLATFORM_TENANT_ID. The tenant needs
 * biometrics switched on (biometric-setup.sh) and at least one connection.
 */
import { consoleClient, env, platformClient } from './platform-common.ts'

const api = platformClient(env('PLATFORM_API', 'https://api.12id.naziharitsolution.com'), env('PLATFORM_API_KEY'))
const setup = consoleClient()

const checks: Array<[string, boolean]> = []
const check = (name: string, ok: boolean, detail = '') => {
  checks.push([name, ok])
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

const rule = { mode: 'conditional', when: { match: 'any', conditions: [{ param: 'amount', op: 'gte', value: 5000 }, { param: 'riskScore', op: 'gt', value: 70 }] }, minMatchScore: 90 }
const schemas = await api.must<{ items: Array<{ name: string }> }>('GET', '/v1/schemas?pageSize=25')
const connections = await api.must<{ items: Array<{ id: string }> }>('GET', '/v1/connections?pageSize=25')
const schemaName = schemas.items[0]?.name
const connectionId = connections.items[0]?.id
if (!schemaName || !connectionId) throw new Error('the tenant needs a published schema and a connection')

const template = await setup.must<{ id: string; biometricPolicy: unknown }>('POST', '/v1/proof-templates', {
  name: `conditional gate check ${Date.now()}`,
  groups: [{ key: 'holder', attributes: ['name'], credentials: [{ schemaName }] }],
  biometricPolicy: rule,
})
try {
  check('the console scope stores a rule on a template', JSON.stringify(template.biometricPolicy) === JSON.stringify(rule), JSON.stringify(template.biometricPolicy))
  const read = await api.must<{ biometricPolicy: unknown }>('GET', `/v1/proof-templates/${template.id}/biometric-policy`)
  check('an API key reads the rule', JSON.stringify(read.biometricPolicy) === JSON.stringify(rule))
  const byKey = await api.call('PUT', `/v1/proof-templates/${template.id}/biometric-policy`, { mode: 'off' })
  check('an API key cannot change it', byKey.status === 403, `${byKey.status}`)

  const definitions = await api.must<{ items: Array<{ id: string }> }>('GET', '/v1/credential-definitions?pageSize=25')
  const onDefinition = await setup.call('PUT', `/v1/credential-definitions/${encodeURIComponent(definitions.items[0]!.id)}/biometric-policy`, rule)
  check('a credential definition refuses a rule', onDefinition.status === 400, `${onDefinition.status}`)

  const before = (await api.must<{ total: number }>('GET', '/v1/proofs?pageSize=25')).total
  for (const [label, biometric] of [['no numbers', undefined], ['one of two numbers', { params: { amount: 9000 } }]] as const) {
    const refused = await api.call<{ error?: string; reason?: string }>('POST', '/v1/proofs/request', { connectionId, templateId: template.id, ...(biometric ? { biometric } : {}) })
    check(`a request with ${label} is refused`, refused.status === 422 && refused.json.error === 'biometric_param_required' && /riskScore/.test(refused.json.reason ?? ''), `${refused.status} ${refused.json.error}: ${refused.json.reason}`)
  }
  const after = (await api.must<{ total: number }>('GET', '/v1/proofs?pageSize=25')).total
  check('no proof exchange was created', after === before, `${before} -> ${after}`)
} finally {
  await setup.call('DELETE', `/v1/proof-templates/${template.id}`)
}

const passed = checks.every(([, ok]) => ok)
console.log(`\n=== conditional-gate-check ${passed ? 'PASSED' : 'FAILED'} (${checks.filter(([, ok]) => ok).length}/${checks.length}) ===`)
process.exit(passed ? 0 : 1)
