/**
 * What a console change was (Phase 7 review L10): the audit used to record the route pattern and the
 * status only, so a bad edit (a webhook URL, a template, a policy, the retention period) could not be
 * reconstructed. The audit now keeps the route parameters and the request body, with two kinds of
 * value replaced wherever they appear:
 *
 * - secrets, by key name (tokens, passwords, webhook secrets, API keys, private keys);
 * - personal data: credential attribute values, disclosed values and face images. The audit has no
 *   retention or erasure path (H1), so personal data must never reach it.
 *
 * A route whose body may carry vendor secrets under arbitrary names opts out entirely with
 * `config: { auditBody: false }`; only its parameters are kept. Long strings are shortened and a
 * snapshot over MAX_SNAPSHOT_BYTES is replaced by its size.
 */
declare module 'fastify' {
  interface FastifyContextConfig {
    /** false: never record this route's body in the audit (it may carry secrets). */
    auditBody?: false
  }
}

export const REDACTED = '[redacted]'
export const PERSONAL_DATA = '[personal data]'
export const NOT_RECORDED = '[not recorded: may carry secrets]'
export const MAX_STRING_LENGTH = 2_000
export const MAX_SNAPSHOT_BYTES = 16 * 1024

const SECRET_KEY = /secret|token|password|passphrase|private|api_?key|access_?key|signature/i
/** Personal data by key: offer values, disclosed values, face images. */
const PERSONAL_KEYS = new Set(['values', 'disclosed', 'referenceImage', 'image'])

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function redact(value: unknown, key: string | null, depth: number): unknown {
  if (key !== null) {
    if (SECRET_KEY.test(key)) return REDACTED
    if (PERSONAL_KEYS.has(key)) return PERSONAL_DATA
    // An offer's `attributes` is a name → value record (personal data); a schema's or a template's
    // `attributes` is a list of names, which is the change itself and stays.
    if (key === 'attributes' && isPlainObject(value)) return PERSONAL_DATA
  }
  if (typeof value === 'string') return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…[+${value.length - MAX_STRING_LENGTH} chars]` : value
  if (depth > 8) return '[nested too deep]'
  if (Array.isArray(value)) return value.map((item) => redact(item, null, depth + 1))
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k, depth + 1)]))
  return value
}

export const MAX_DETAIL_BYTES = 2 * 1024

/**
 * The audit's `changes` value for an event the console reported (a sign-in, an account change, an
 * export; `routes/audit-events.ts`): the same replacements, and a smaller cap, since the detail is a
 * few facts (an address, a list name, a count), never a document.
 */
export function auditDetail(detail: unknown): Record<string, unknown> | null {
  if (!isPlainObject(detail) || Object.keys(detail).length === 0) return null
  const cleaned = redact(detail, null, 0) as Record<string, unknown>
  const bytes = Buffer.byteLength(JSON.stringify(cleaned), 'utf8')
  return bytes > MAX_DETAIL_BYTES ? { truncated: true, bytes } : cleaned
}

/** The audit's `changes` value for one request, or null when there is nothing to record. */
export function auditChanges(input: { params?: unknown; body?: unknown; recordBody: boolean }): Record<string, unknown> | null {
  const changes: Record<string, unknown> = {}
  if (isPlainObject(input.params) && Object.keys(input.params).length > 0) changes.params = redact(input.params, null, 0)
  if (input.body !== undefined && input.body !== null) changes.body = input.recordBody ? redact(input.body, null, 0) : NOT_RECORDED
  if (Object.keys(changes).length === 0) return null
  const bytes = Buffer.byteLength(JSON.stringify(changes), 'utf8')
  return bytes > MAX_SNAPSHOT_BYTES ? { truncated: true, bytes, ...(changes.params ? { params: changes.params } : {}) } : changes
}
