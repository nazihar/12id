/**
 * Prints what tenant.json needs, read with the API key: the organisation's credential definitions and
 * proof templates, with their ids.
 *
 *   PLATFORM_API_URL=… PLATFORM_API_KEY=… node src/tenant-info.ts
 */
export {}

const baseUrl = (process.env.PLATFORM_API_URL ?? '').replace(/\/+$/, '')
const apiKey = process.env.PLATFORM_API_KEY ?? ''
if (!baseUrl || !apiKey) throw new Error('set PLATFORM_API_URL and PLATFORM_API_KEY')

async function list<T>(path: string): Promise<T[]> {
  const response = await fetch(`${baseUrl}${path}?pageSize=100`, { headers: { authorization: `Bearer ${apiKey}` } })
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status} ${await response.text()}`)
  return ((await response.json()) as { items: T[] }).items
}

const definitions = await list<{ id: string; schemaName: string; schemaVersion: string; tag: string; status: string }>('/v1/credential-definitions')
const templates = await list<{ id: string; name: string; definition: { groups: { attributes: string[]; predicates?: { name: string; type: string; value: number }[] }[] } }>('/v1/proof-templates')

console.log('Credential definitions (tenant.json "credentialDefinitionId"):')
for (const d of definitions) console.log(`  ${d.id}  ${d.schemaName} ${d.schemaVersion} (${d.tag}, ${d.status})`)
console.log('\nProof templates (tenant.json "actions.<name>.proofTemplateId"):')
for (const t of templates) {
  const shows = t.definition.groups.flatMap((g) => g.attributes).join(', ') || 'nothing'
  const proves = t.definition.groups.flatMap((g) => g.predicates ?? []).map((p) => `${p.name} ${p.type} ${p.value}`).join(', ') || 'nothing more'
  console.log(`  ${t.id}  "${t.name}"  shows: ${shows}; proves: ${proves}`)
}
