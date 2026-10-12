/**
 * The audit log's period (implement/22-console-feedback.md C15): the values platform-api accepts,
 * for the server functions' validators and the form. Client-safe.
 */
import { z } from 'zod'

export const AUDIT_RETENTION_MIN_DAYS = 365
export const AUDIT_RETENTION_MAX_DAYS = 3650

/** A year to ten years, or 0 to keep everything. */
export const validAuditRetentionDays = (days: number) => Number.isInteger(days) && (days === 0 || (days >= AUDIT_RETENTION_MIN_DAYS && days <= AUDIT_RETENTION_MAX_DAYS))

/** null = the platform default. */
export const auditRetentionDaysInput = z.number().int().refine(validAuditRetentionDays, `0, or ${AUDIT_RETENTION_MIN_DAYS} to ${AUDIT_RETENTION_MAX_DAYS} days`).nullable()
