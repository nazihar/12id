/** Client-safe search schemas of the cross-tenant operator lists (Phase 4 C9). */
import { z } from 'zod'

import { deliverySearch } from '@/features/tenant-data/list.schemas'
import { datedListSearch } from '@/lib/list-search'

/** Deliveries across tenants; the page shows dead letters unless another status is chosen. */
export const opsDeliverySearch = deliverySearch.extend({ tenantId: z.uuid().optional() })
export type OpsDeliverySearch = z.infer<typeof opsDeliverySearch>

/** Audit log: one search (`q`) over the actor's name or email, the actor id and the route. */
export const auditSearch = datedListSearch.extend({ tenantId: z.uuid().optional() })
export type AuditSearch = z.infer<typeof auditSearch>
