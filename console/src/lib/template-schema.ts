/**
 * Proof template shape and static rules, mirrored from platform-api (services/platform-api/src/templates.ts)
 * so the builder can explain problems before saving. platform-api stays authoritative.
 */
import { z } from 'zod'

export const EXPIRY_ATTRIBUTE = 'expiresAt'

const attributeName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/, 'attribute names are 1-100 characters of letters, digits, _ . -')

export const templateCredentialRef = z.union([
  z.object({ schemaName: z.string().min(1).max(200), versions: z.enum(['active', 'all']).default('all') }),
  z.object({ credentialDefinitionId: z.string().min(1).max(300) }),
])

export const templateGroup = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,50}$/, 'group keys are 1-50 characters of letters, digits, _ -'),
  attributes: z.array(attributeName).max(50).default([]),
  credentials: z.array(templateCredentialRef).min(1, 'choose at least one credential').max(20),
  predicates: z.array(z.object({ name: attributeName, type: z.enum(['>=', '>', '<=', '<']), value: z.number().int() })).max(20).optional(),
})

export const templateDefinition = z.object({
  name: z.string().min(1, 'give the template a name').max(100),
  groups: z.array(templateGroup).min(1).max(20),
})

export type TemplateDefinition = z.infer<typeof templateDefinition>
export type TemplateGroup = TemplateDefinition['groups'][number]
export type TemplateCredentialRef = TemplateGroup['credentials'][number]
export type TemplatePredicate = NonNullable<TemplateGroup['predicates']>[number]

/** Every rule platform-api checks without the catalogue, as readable messages. Empty when valid. */
export function templateProblems(definition: TemplateDefinition): string[] {
  const parsed = templateDefinition.safeParse(definition)
  const problems = parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.') || 'template'}: ${issue.message}`)
  const keys = definition.groups.map((group) => group.key)
  if (new Set(keys).size !== keys.length) problems.push('group keys must be unique')
  for (const group of definition.groups) {
    if (group.attributes.includes(EXPIRY_ATTRIBUTE)) problems.push(`${group.key}: ${EXPIRY_ATTRIBUTE} cannot be disclosed; it is always checked`)
    if (group.predicates?.some((p) => p.name === EXPIRY_ATTRIBUTE)) problems.push(`${group.key}: ${EXPIRY_ATTRIBUTE} is checked automatically`)
    const predicated = new Set(group.predicates?.map((p) => p.name))
    const both = group.attributes.filter((a) => predicated.has(a))
    if (both.length > 0) problems.push(`${group.key}: an attribute cannot be both disclosed and predicated (${both.join(', ')})`)
    if (group.attributes.length === 0 && !group.predicates?.length) problems.push(`${group.key}: disclose at least one attribute or add a predicate`)
  }
  return problems
}
