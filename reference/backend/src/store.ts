/**
 * What this backend remembers, in one JSON file. A real backend keeps the same few columns in its own
 * database: per user and installation, the 12id wallet and connection; per action, the proof request.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface User {
  id: string
  name: string
  memberId: string
  /** A UUID the app creates once and keeps. A reinstall is a new installation, so a new wallet. */
  installationId: string
  sessionTokenHash: string
  walletId: string | null
  /** Kept because the platform hands a wallet token out once (see wallet() in server.ts). */
  walletToken: string | null
  /** Raised when the platform says the wallet was revoked, to create the next one under a new key. */
  walletGeneration: number
  /** Set by the connection.state_changed webhook; every later offer and proof request goes here. */
  connectionId: string | null
  /** The latest credential.state_changed state: offer-sent … done, or abandoned. Null: no offer was accepted by the platform yet. */
  credentialState: string | null
  /** How many offers ended without a card (declined, timed out); part of the next offer's Idempotency-Key. */
  offerAttempt?: number
}

export interface Action {
  id: string
  userId: string
  type: string
  /** Whatever the app sent (amount, payee); shown back to the app, never sent to 12id. */
  details: Record<string, string>
  state: 'pending' | 'approved' | 'declined' | 'failed'
  proofId: string | null
  /** What the user's wallet revealed, by template group. */
  disclosed: Record<string, Record<string, string>> | null
  createdAt: string
}

interface Data {
  users: Record<string, User>
  actions: Record<string, Action>
}

export class Store {
  private readonly file: string
  private data: Data

  constructor(file: string) {
    this.file = file
    try {
      this.data = JSON.parse(readFileSync(file, 'utf8')) as Data
    } catch {
      this.data = { users: {}, actions: {} }
    }
  }

  user(id: string): User | undefined {
    return this.data.users[id]
  }

  findUser(match: (user: User) => boolean): User | undefined {
    return Object.values(this.data.users).find(match)
  }

  saveUser(user: User): User {
    this.data.users[user.id] = user
    this.write()
    return user
  }

  action(id: string): Action | undefined {
    return this.data.actions[id]
  }

  saveAction(action: Action): Action {
    this.data.actions[action.id] = action
    this.write()
    return action
  }

  /** Written to a temporary file and renamed, so a crash never leaves half a file. */
  private write() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
