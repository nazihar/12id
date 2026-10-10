/**
 * Compares tenant.json with the organisation's catalogue, read with the API key. A mismatch here is
 * what otherwise shows up much later as "the card never arrives": the platform refuses an offer whose
 * attributes are not exactly the schema's.
 */
import type { Tenant } from './config.ts'

export interface Catalogue {
  definitions: { id: string; credentialDefinitionId: string | null; schemaId: string | null; schemaName: string; schemaVersion: string; tag: string; status: string }[]
  schemas: { id: string; name: string; version: string; attributes: string[] }[]
  templates: { id: string; name: string; definition: { groups: { attributes: string[]; predicates?: { name: string; type: string; value: number }[] }[] } }[]
  /** Face-check policy of the ids tenant.json uses: 'required', 'off' or 'inherit' (the organisation's default decides). */
  facePolicies?: Record<string, string>
}

export async function fetchCatalogue(baseUrl: string, apiKey: string, tenant?: Tenant): Promise<Catalogue> {
  const get = (path: string) => fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) })
  async function list<T>(path: string): Promise<T[]> {
    const response = await get(`${path}?pageSize=100`)
    if (!response.ok) throw new Error(`GET ${path} answered ${response.status} ${await response.text()}`)
    return ((await response.json()) as { items: T[] }).items
  }
  /** The policy set in the console (Biometrics); an id the organisation does not have simply has none. */
  async function facePolicy(path: string): Promise<string | undefined> {
    const response = await get(`${path}/biometric-policy`)
    return response.ok ? ((await response.json()) as { biometricPolicy?: { mode?: string } }).biometricPolicy?.mode : undefined
  }
  const [definitions, schemas, templates] = await Promise.all([
    list<Catalogue['definitions'][number]>('/v1/credential-definitions'),
    list<Catalogue['schemas'][number]>('/v1/schemas'),
    list<Catalogue['templates'][number]>('/v1/proof-templates'),
  ])
  const facePolicies: Record<string, string> = {}
  if (tenant) {
    const ids = [[tenant.credentialDefinitionId, '/v1/credential-definitions'], ...Object.values(tenant.actions).map((a) => [a.proofTemplateId, '/v1/proof-templates'])]
    for (const [id, path] of ids) {
      const mode = await facePolicy(`${path}/${encodeURIComponent(id)}`)
      if (mode) facePolicies[id] = mode
    }
  }
  return { definitions, schemas, templates, facePolicies }
}

/** What is wrong with tenant.json for this catalogue, one sentence each; empty when it fits. */
export function tenantProblems(tenant: Tenant, catalogue: Catalogue): string[] {
  const problems: string[] = []
  const definition = catalogue.definitions.find((d) => d.id === tenant.credentialDefinitionId || d.credentialDefinitionId === tenant.credentialDefinitionId)
  if (!definition) {
    problems.push(`credentialDefinitionId ${tenant.credentialDefinitionId} is not one of this organisation's credential definitions`)
  } else {
    const name = `${definition.schemaName} ${definition.schemaVersion}`
    if (definition.status !== 'published') problems.push(`the credential definition for ${name} is ${definition.status}; offers from it are refused`)
    const schema = catalogue.schemas.find((s) => s.id === definition.schemaId) ?? catalogue.schemas.find((s) => s.name === definition.schemaName && s.version === definition.schemaVersion)
    if (schema) {
      const wanted = schema.attributes.filter((a) => a !== 'expiresOn')
      const given = Object.keys(tenant.credential.attributes)
      const missing = wanted.filter((a) => !given.includes(a))
      const extra = given.filter((a) => !wanted.includes(a))
      if (missing.length > 0) problems.push(`credential.attributes lacks ${missing.join(', ')}, which schema ${name} has`)
      if (extra.length > 0) problems.push(`credential.attributes has ${extra.join(', ')}, which schema ${name} does not have`)
    }
  }
  for (const [action, { proofTemplateId }] of Object.entries(tenant.actions)) {
    if (!catalogue.templates.some((t) => t.id === proofTemplateId)) problems.push(`actions.${action}.proofTemplateId ${proofTemplateId} is not one of this organisation's proof templates`)
  }
  // A face check needs a reference photo with every offer or request; without one the platform refuses them.
  const gated = Object.entries(catalogue.facePolicies ?? {}).filter(([, mode]) => mode === 'required').map(([id]) => id)
  if (gated.length > 0 && tenant.photoOnFile !== true) problems.push(`a face check is required for ${gated.join(', ')} (console, Biometrics): set "photoOnFile": true`)
  return problems
}
