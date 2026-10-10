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
}

export async function fetchCatalogue(baseUrl: string, apiKey: string): Promise<Catalogue> {
  async function list<T>(path: string): Promise<T[]> {
    const response = await fetch(`${baseUrl}${path}?pageSize=100`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`GET ${path} answered ${response.status} ${await response.text()}`)
    return ((await response.json()) as { items: T[] }).items
  }
  const [definitions, schemas, templates] = await Promise.all([
    list<Catalogue['definitions'][number]>('/v1/credential-definitions'),
    list<Catalogue['schemas'][number]>('/v1/schemas'),
    list<Catalogue['templates'][number]>('/v1/proof-templates'),
  ])
  return { definitions, schemas, templates }
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
  return problems
}
