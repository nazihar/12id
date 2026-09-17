/** Client-safe input schemas shared by the operator tenant forms and the server functions' validators. */
import { z } from 'zod'

import { emailAddress, personName } from '@/features/operators/operators.schemas'

export const tenantInput = z.object({ tenantId: z.uuid() })

export const createTenantInput = z.object({ name: z.string().trim().min(1, 'Enter the organization name.').max(200, 'Use at most 200 characters.') })
export type CreateTenantInput = z.input<typeof createTenantInput>

export const apiKeyLabel = z.string().trim().min(1, 'Give the key a label.').max(100, 'Use at most 100 characters.')
export const createApiKeyInput = z.object({ label: apiKeyLabel })
export type CreateApiKeyInput = z.input<typeof createApiKeyInput>

export const createTenantOrganizationInput = z.object({ ownerName: personName, ownerEmail: emailAddress })
export type CreateTenantOrganizationInput = z.input<typeof createTenantOrganizationInput>
