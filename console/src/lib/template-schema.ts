/**
 * Proof template shape and static rules, mirrored from platform-api (services/platform-api/src/templates.ts)
 * so the builder can explain problems before saving. platform-api stays authoritative.
 */
import { z } from 'zod'

export const EXPIRY_ATTRIBUTE = 'expiresAt'

export const attributeName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/, 'Attribute names are 1-100 characters of letters, digits, _ . -')

export const PREDICATE_TYPES = ['>=', '>', '<=', '<'] as const

export const templateCredentialRef = z.union([
  z.object({ schemaName: z.string().min(1).max(200), versions: z.enum(['active', 'all']).default('all') }),
  z.object({ credentialDefinitionId: z.string().min(1).max(300) }),
])

export const templatePredicate = z.object({
  name: attributeName,
  type: z.enum(PREDICATE_TYPES),
  value: z.number('Enter a whole number.').int('Enter a whole number.'),
})

export const templateGroup = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,50}$/, 'Group keys are 1-50 characters of letters, digits, _ -'),
  attributes: z.array(attributeName).max(50).default([]),
  credentials: z.array(templateCredentialRef).min(1, 'Choose at least one credential type.').max(20),
  predicates: z.array(templatePredicate).max(20).optional(),
})

/** The shape platform-api accepts. */
export const templateDefinition = z.object({
  name: z.string().trim().min(1, 'Give the template a name.').max(100, 'Use at most 100 characters.'),
  groups: z.array(templateGroup).min(1, 'Request at least one credential.').max(20),
})

export type TemplateDefinition = z.infer<typeof templateDefinition>
export type TemplateGroup = TemplateDefinition['groups'][number]
export type TemplateCredentialRef = TemplateGroup['credentials'][number]
export type TemplatePredicate = NonNullable<TemplateGroup['predicates']>[number]

/** The rules platform-api checks without the catalogue, each issue placed on the field it concerns. */
type Checkable = { groups: Array<{ key: string; attributes?: string[]; predicates?: Array<{ name: string }> }> }
function templateRules(definition: Checkable, ctx: z.RefinementCtx) {
  const seen = new Map<string, number>()
  definition.groups.forEach((group, index) => {
    const path = ['groups', index]
    const attributes = group.attributes ?? []
    const first = seen.get(group.key)
    if (first !== undefined) ctx.addIssue({ code: 'custom', path: [...path, 'key'], message: `Group keys must be unique; "${group.key}" is also group ${first + 1}.` })
    else seen.set(group.key, index)

    if (attributes.includes(EXPIRY_ATTRIBUTE)) ctx.addIssue({ code: 'custom', path: [...path, 'attributes'], message: `${EXPIRY_ATTRIBUTE} cannot be disclosed; it is always checked.` })
    group.predicates?.forEach((predicate, predicateIndex) => {
      if (predicate.name === EXPIRY_ATTRIBUTE) ctx.addIssue({ code: 'custom', path: [...path, 'predicates', predicateIndex, 'name'], message: `${EXPIRY_ATTRIBUTE} is checked automatically.` })
      if (attributes.includes(predicate.name)) ctx.addIssue({ code: 'custom', path: [...path, 'predicates', predicateIndex, 'name'], message: `${predicate.name} is already disclosed; an attribute cannot be both disclosed and predicated.` })
    })
    if (attributes.length === 0 && !group.predicates?.length) ctx.addIssue({ code: 'custom', path: [...path, 'attributes'], message: 'Disclose at least one attribute or add a predicate.' })
  })
}

/** What the server functions validate: the platform-api shape plus the rules above. */
export const templateDefinitionInput = templateDefinition.superRefine(templateRules)

/**
 * What the builder holds: the same shape with every array present, so each list is a form field.
 * Issues land on `groups[i].key`, `groups[i].attributes`, `groups[i].predicates[j].name` and so on.
 */
export const templateDefinitionForm = z
  .object({
    name: templateDefinition.shape.name,
    groups: z
      .array(
        z.object({
          key: templateGroup.shape.key,
          attributes: z.array(attributeName).max(50),
          credentials: z.array(z.union([z.object({ schemaName: z.string().min(1).max(200), versions: z.enum(['active', 'all']) }), z.object({ credentialDefinitionId: z.string().min(1).max(300) })])).min(1, 'Choose at least one credential type.').max(20),
          predicates: z.array(templatePredicate).max(20),
        })
      )
      .min(1, 'Request at least one credential.')
      .max(20),
  })
  .superRefine(templateRules)
export type TemplateFormValues = z.input<typeof templateDefinitionForm>

/** Every problem as a readable `path: message` line. Empty when valid. */
export function templateProblems(definition: TemplateDefinition): string[] {
  const parsed = templateDefinitionInput.safeParse(definition)
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.') || 'template'}: ${issue.message}`)
}
