/** Client-safe input schemas shared by the operator tenant forms and the server functions' validators. */
import { z } from 'zod'

import { emailAddress, personName } from '@/features/operators/operators.schemas'
import { listSearch } from '@/lib/list-search'

export const tenantInput = z.object({ tenantId: z.uuid() })

/** Operator tenants list (Phase 4 C9): search by name, filter by onboarding status. */
export const TENANT_STATUSES = ['provisioning', 'ready', 'failed'] as const
export const tenantListSearch = listSearch.extend({ status: z.enum(TENANT_STATUSES).optional() })
export type TenantListSearch = z.infer<typeof tenantListSearch>
export const tenantStatusOptions = TENANT_STATUSES.map((value) => ({ value, label: value }))

export const createTenantInput = z.object({ name: z.string().trim().min(1, 'Enter the organization name.').max(200, 'Use at most 200 characters.') })
export type CreateTenantInput = z.input<typeof createTenantInput>

export const apiKeyLabel = z.string().trim().min(1, 'Give the key a label.').max(100, 'Use at most 100 characters.')
export const createApiKeyInput = z.object({ label: apiKeyLabel })
export type CreateApiKeyInput = z.input<typeof createApiKeyInput>

/** Per-API-key request limit (platform review M4): the platform default, or a number (0 = no limit). */
export const rateLimitInput = z.object({
  useDefault: z.boolean(),
  rateLimitPerMin: z.number({ error: 'Enter requests per minute.' }).int('Use a whole number.').min(0, 'At least 0.').max(100_000, 'At most 100000.'),
})
export type RateLimitInput = z.input<typeof rateLimitInput>

export const createTenantOrganizationInput = z.object({ ownerName: personName, ownerEmail: emailAddress })
export type CreateTenantOrganizationInput = z.input<typeof createTenantOrganizationInput>
