/**
 * Prints what tenant.json needs, read with the API key: the organisation's credential definitions and
 * proof templates, with their ids. When tenant.json exists, it also says whether it fits them.
 *
 *   PLATFORM_API_URL=… PLATFORM_API_KEY=… node src/tenant-info.ts
 */
import { loadTenant } from './config.ts'
import { fetchCatalogue, tenantProblems } from './tenant-check.ts'

const baseUrl = (process.env.PLATFORM_API_URL ?? '').replace(/\/+$/, '')
const apiKey = process.env.PLATFORM_API_KEY ?? ''
if (!baseUrl || !apiKey) throw new Error('set PLATFORM_API_URL and PLATFORM_API_KEY')

const catalogue = await fetchCatalogue(baseUrl, apiKey)

console.log('Credential definitions (tenant.json "credentialDefinitionId"):')
for (const d of catalogue.definitions) {
  const schema = catalogue.schemas.find((s) => s.id === d.schemaId)
  const attributes = schema ? schema.attributes.filter((a) => a !== 'expiresOn').join(', ') : '?'
  console.log(`  ${d.id}  ${d.schemaName} ${d.schemaVersion} (${d.status})  attributes: ${attributes}`)
}
console.log('\nProof templates (tenant.json "actions.<name>.proofTemplateId"):')
for (const t of catalogue.templates) {
  const shows = t.definition.groups.flatMap((g) => g.attributes).join(', ') || 'nothing'
  const proves = t.definition.groups.flatMap((g) => g.predicates ?? []).map((p) => `${p.name} ${p.type} ${p.value}`).join(', ') || 'nothing more'
  console.log(`  ${t.id}  "${t.name}"  shows: ${shows}; proves: ${proves}`)
}

const file = process.env.TENANT_FILE ?? './tenant.json'
let problems: string[] | undefined
try {
  problems = tenantProblems(loadTenant(file), catalogue)
} catch (error) {
  console.log(`\n${file}: ${(error as Error).message}`)
}
if (problems) console.log(problems.length === 0 ? `\n${file} fits this catalogue.` : `\n${file} does not fit:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
