/**
 * Proof templates (P4). A template names credentials by *type* (schema name, optionally across
 * versions) or by an explicit cred def id; expansion resolves each entry to the unqualified cred
 * def ids the agent accepts on the wire, at request time, from the tenant's live catalogue.
 * That is what lets a template keep verifying credentials issued under a deprecated schema
 * version (4-init §5.1).
 */
import { z } from 'zod'

import type { AgentLedgerObject, AgentProofGroup } from './agent-client.ts'
import { badRequest } from './http/errors.ts'

export const EXPIRY_ATTRIBUTE = 'expiresAt'

const attributeName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/, 'attribute names are 1-100 chars of [A-Za-z0-9_.-]')

export const templateCredentialRef = z.union([
  z.object({ schemaName: z.string().min(1).max(200), versions: z.enum(['active', 'all']).default('all') }),
  z.object({ credentialDefinitionId: z.string().min(1).max(300) }),
])

export const templateGroup = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,50}$/),
  attributes: z.array(attributeName).max(50).default([]),
  credentials: z.array(templateCredentialRef).min(1).max(20),
  predicates: z.array(z.object({ name: attributeName, type: z.enum(['>=', '>', '<=', '<']), value: z.number().int() })).max(20).optional(),
})

export const templateDefinition = z.object({
  /** Shown to the holder as the proof request name. */
  name: z.string().min(1).max(100),
  groups: z.array(templateGroup).min(1).max(20),
})
export type TemplateDefinition = z.infer<typeof templateDefinition>

/** Static rules that do not need the catalogue. Throws PlatformError(400). */
export function validateTemplate(definition: TemplateDefinition) {
  for (const group of definition.groups) {
    // The agent adds an `expiresAt >=` predicate to every group, and AnonCreds v1 refuses an
    // attribute that is both revealed and predicated (Phase 2 A5 trap 1).
    if (group.attributes.includes(EXPIRY_ATTRIBUTE)) throw badRequest(`group ${group.key}: ${EXPIRY_ATTRIBUTE} cannot be disclosed; it is always checked by predicate`)
    if (group.predicates?.some((p) => p.name === EXPIRY_ATTRIBUTE)) throw badRequest(`group ${group.key}: ${EXPIRY_ATTRIBUTE} is predicated automatically`)
    const predicated = new Set(group.predicates?.map((p) => p.name))
    const both = group.attributes.filter((a) => predicated.has(a))
    if (both.length > 0) throw badRequest(`group ${group.key}: attributes cannot be both disclosed and predicated: ${both.join(', ')}`)
    if (group.attributes.length === 0 && !group.predicates?.length) throw badRequest(`group ${group.key}: nothing to disclose or predicate`)
  }
  const keys = definition.groups.map((g) => g.key)
  if (new Set(keys).size !== keys.length) throw badRequest('group keys must be unique')
}

/** Resolves credential references against the tenant catalogue. Throws PlatformError(400/409). */
export function expandTemplate(definition: TemplateDefinition, catalogue: AgentLedgerObject[]): AgentProofGroup[] {
  validateTemplate(definition)
  const credDefs = catalogue.filter((o) => o.kind === 'credential_definition' && o.unqualifiedId)
  return definition.groups.map((group) => {
    const ids = new Set<string>()
    for (const ref of group.credentials) {
      if ('credentialDefinitionId' in ref) {
        const match = credDefs.find((c) => c.unqualifiedId === ref.credentialDefinitionId || c.id === ref.credentialDefinitionId)
        if (!match?.unqualifiedId) throw badRequest(`group ${group.key}: unknown credential definition ${ref.credentialDefinitionId}`)
        ids.add(match.unqualifiedId)
      } else {
        const statuses = ref.versions === 'active' ? ['published'] : ['published', 'deprecated']
        const matches = credDefs.filter((c) => c.name === ref.schemaName && statuses.includes(c.status))
        if (matches.length === 0) throw badRequest(`group ${group.key}: no ${ref.versions === 'active' ? 'active ' : ''}credential definitions for schema "${ref.schemaName}"`)
        for (const m of matches) ids.add(m.unqualifiedId as string)
      }
    }
    return { key: group.key, attributes: group.attributes, credentialDefinitionIds: [...ids], predicates: group.predicates }
  })
}
