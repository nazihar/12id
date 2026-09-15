import { z } from 'zod'

/**
 * Mutations name the organization the page was showing. The session's active organization can change
 * in another tab; acting on the other tenant silently would be worse than asking for a reload.
 */
export const organizationInput = z.object({ organizationId: z.string().min(1).max(100) })

export function assertSameOrganization(activeOrganizationId: string, requestedOrganizationId: string) {
  if (activeOrganizationId !== requestedOrganizationId) throw new Error('The active organization changed in another tab. Reload this page.')
}
