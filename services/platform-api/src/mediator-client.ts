/**
 * Two narrow views of the mediator (P1, P7):
 *   - the patched `POST /admin/invitations` route, which mints one single-use out-of-band
 *     invitation per wallet;
 *   - a read-only query on its Drizzle Postgres database, mapping a mediator-side connection id
 *     (the only thing its webhook carries) to the out-of-band id that invitation created.
 *
 * Nothing here writes to the mediator's storage.
 */
import pg from 'pg'

export interface MediatorClient {
  createInvitation(): Promise<{ outOfBandId: string; invitationUrl: string }>
  /** Out-of-band id of the connection, or null when the mediator does not know the connection. */
  outOfBandIdForConnection(connectionId: string): Promise<string | null>
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
