/**
 * Correlation ids (A7). Set on a connection / credential / proof record when the platform starts
 * the exchange, carried into every outbox row and log line. Across hosts, match on the DIDComm
 * thread id plus this id, never on timestamps (Phase 1 measured a 53 s clock skew).
 *
 * Credo emits the first state event (`offer-sent`, `request-sent`) inside the API call, before
 * the caller can touch the record's metadata. `PendingCorrelations` bridges that gap: the exchange
 * function announces the id for (tenant, connection, kind) before calling Credo; the outbox
 * listener consumes it on the first event for that key. Single-process by design (one replica in
 * v1); the metadata on the record is the durable copy.
 */
export const CORRELATION_METADATA_KEY = '12id'

export interface CorrelationMetadata {
  correlationId: string
}

interface RecordWithMetadata {
  metadata: {
    get(key: string): Record<string, unknown> | null
    set(key: string, value: Record<string, unknown>): void
  }
}

export function setCorrelationId(record: RecordWithMetadata, correlationId: string) {
  record.metadata.set(CORRELATION_METADATA_KEY, { correlationId } satisfies CorrelationMetadata)
}

export function getCorrelationId(record: RecordWithMetadata): string | null {
  const value = record.metadata.get(CORRELATION_METADATA_KEY)?.correlationId
  return typeof value === 'string' ? value : null
}

export type CorrelationKind = 'connection' | 'credential' | 'proof'

export class PendingCorrelations {
  private readonly pending = new Map<string, string[]>()
  /** record id → correlation stamped by the listener; bounded so it cannot grow unbounded. */
  private readonly stamped = new Map<string, string>()
  private static readonly STAMPED_LIMIT = 10_000

  public remember(tenantId: string, kind: CorrelationKind, recordId: string, correlationId: string) {
    const key = this.key(tenantId, kind, recordId)
    if (this.stamped.size >= PendingCorrelations.STAMPED_LIMIT) {
      const oldest = this.stamped.keys().next().value
      if (oldest !== undefined) this.stamped.delete(oldest)
    }
    this.stamped.set(key, correlationId)
  }

  public recall(tenantId: string, kind: CorrelationKind, recordId: string): string | null {
    return this.stamped.get(this.key(tenantId, kind, recordId)) ?? null
  }

  private key(tenantId: string, kind: CorrelationKind, anchor: string) {
    return `${tenantId}|${kind}|${anchor}`
  }

  /** `anchor` is the connection id for credentials/proofs, the out-of-band id for connections. */
  public announce(tenantId: string, kind: CorrelationKind, anchor: string, correlationId: string) {
    const key = this.key(tenantId, kind, anchor)
    this.pending.set(key, [...(this.pending.get(key) ?? []), correlationId])
  }

  /** Returns and removes the oldest pending id for the key, FIFO for concurrent offers. */
  public consume(tenantId: string, kind: CorrelationKind, anchor: string): string | null {
    const key = this.key(tenantId, kind, anchor)
    const queue = this.pending.get(key)
    if (!queue || queue.length === 0) return null
    const [first, ...rest] = queue
    if (rest.length === 0) this.pending.delete(key)
    else this.pending.set(key, rest)
    return first
  }

  /** Drops an announcement when the Credo call failed and no event will consume it. */
  public cancel(tenantId: string, kind: CorrelationKind, anchor: string, correlationId: string) {
    const key = this.key(tenantId, kind, anchor)
    const queue = (this.pending.get(key) ?? []).filter((id) => id !== correlationId)
    if (queue.length === 0) this.pending.delete(key)
    else this.pending.set(key, queue)
  }
}
