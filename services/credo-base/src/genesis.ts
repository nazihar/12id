import { createHash } from 'node:crypto'

/**
 * Fetches the pool genesis and refuses it unless it matches the pinned sha256.
 *
 * The sha is required, not optional: a genesis file from the wrong source points the agent at
 * a different ledger (4-init §6). Publish a new pinned value with every genesis version
 * (infra/runbooks/genesis-rotation.md).
 */
export async function fetchPinnedGenesis(url: string, sha256: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`genesis fetch from ${url} failed: HTTP ${response.status}`)
  const text = await response.text()
  const actual = createHash('sha256').update(text).digest('hex')
  if (actual !== sha256.toLowerCase()) {
    throw new Error(`genesis from ${url} has sha256 ${actual}, expected ${sha256}`)
  }
  return text
}
