/**
 * Narrow views of the mediator (P1, P7, review M10):
 *   - the patched admin routes: `POST /admin/invitations` mints one single-use out-of-band
 *     invitation per wallet; `DELETE /admin/connections/:id` removes a revoked wallet's connection,
 *     mediation and queue; `POST /admin/sweep` deletes unused invitations and stale queue rows;
 *   - read-only queries on its Drizzle Postgres database (role `platform_ro`): a mediator-side
 *     connection id (the only thing its webhook carries) to the out-of-band id that invitation
 *     created, and back.
 *
 * Writes to the mediator's storage go only through its own admin routes, so Credo stays consistent.
 */
import pg from 'pg'

export interface MediatorClient {
  createInvitation(): Promise<{ outOfBandId: string; invitationUrl: string }>
  /** Out-of-band id of the connection, or null when the mediator does not know the connection. */
  outOfBandIdForConnection(connectionId: string): Promise<string | null>
  /** Mediator connections created from these invitations (out-of-band id → connection ids). */
  connectionsForOutOfBandIds(outOfBandIds: string[]): Promise<Map<string, string[]>>
  /** Removes a connection's mediation, the connection and its queued messages (idempotent). */
  removeConnection(connectionId: string): Promise<{ mediations: number; connections: number; queued: number }>
  /** Deletes unused invitations older than `invitationsOlderThanHours` and queued messages older than `queuedOlderThanDays`. */
  sweep(options: { invitationsOlderThanHours: number; queuedOlderThanDays: number }): Promise<{ invitations: number; queued: number }>
  healthy(): Promise<boolean>
  close(): Promise<void>
}

export interface MediatorClientOptions {
  adminUrl: string
  adminToken: string
  drizzleUrl: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export function createMediatorClient(options: MediatorClientOptions): MediatorClient {
  const doFetch = options.fetch ?? fetch
  const pool = new pg.Pool({ connectionString: options.drizzleUrl, max: 2 })

  async function admin<T>(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await doFetch(new URL(path, options.adminUrl), {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-admin-token': options.adminToken },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      })
    } catch (error) {
      throw new Error(`mediator admin route unreachable: ${(error as Error).message}`)
    }
    if (!response.ok) throw new Error(`mediator ${method} ${path} failed with HTTP ${response.status}`)
    return (await response.json()) as T
  }

  return {
    async createInvitation() {
      let response: Response
      try {
        response = await doFetch(new URL('/admin/invitations', options.adminUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-admin-token': options.adminToken },
          body: '{}',
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        })
      } catch (error) {
        throw new Error(`mediator admin route unreachable: ${(error as Error).message}`)
      }
      if (!response.ok) throw new Error(`mediator POST /admin/invitations failed with HTTP ${response.status}`)
      const json = (await response.json()) as { outOfBandId?: unknown; invitationUrl?: unknown }
      if (typeof json.outOfBandId !== 'string' || typeof json.invitationUrl !== 'string') throw new Error('mediator returned an invalid invitation payload')
      return { outOfBandId: json.outOfBandId, invitationUrl: json.invitationUrl }
    },

    async connectionsForOutOfBandIds(outOfBandIds) {
      const found = new Map<string, string[]>()
      if (outOfBandIds.length === 0) return found
      const result = await pool.query<{ id: string; out_of_band_id: string }>('select id, out_of_band_id from "DidcommConnection" where out_of_band_id = any($1)', [outOfBandIds])
      for (const row of result.rows) found.set(row.out_of_band_id, [...(found.get(row.out_of_band_id) ?? []), row.id])
      return found
    },

    async removeConnection(connectionId) {
      return admin<{ mediations: number; connections: number; queued: number }>('DELETE', `/admin/connections/${encodeURIComponent(connectionId)}`)
    },

    async sweep(options) {
      return admin<{ invitations: number; queued: number }>('POST', '/admin/sweep', options)
    },

    async outOfBandIdForConnection(connectionId) {
      const result = await pool.query<{ out_of_band_id: string | null }>('select out_of_band_id from "DidcommConnection" where id = $1 limit 1', [connectionId])
      return result.rows[0]?.out_of_band_id ?? null
    },

    async healthy() {
      try {
        await pool.query('select 1')
        return true
      } catch {
        return false
      }
    },

    close: () => pool.end(),
  }
}
