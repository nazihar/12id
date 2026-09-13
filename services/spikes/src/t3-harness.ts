/** Shared plumbing for the T3 orchestrators: run t3-issuer.ts as a child and drive it. */
import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { env } from './common.ts'

export interface IssuerChild {
  child: ChildProcess
  output: string[]
  waitFor(pattern: RegExp, timeoutMs: number): Promise<string>
  exited: Promise<number | null>
}

export function startIssuer(label: string, extraEnv: Record<string, string> = {}): IssuerChild {
  const script = fileURLToPath(new URL('./t3-issuer.ts', import.meta.url))
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output: string[] = []
  const waiters: Array<{ pattern: RegExp; resolve: (line: string) => void }> = []
  const onLine = (line: string) => {
    output.push(line)
    console.log(`    [${label}] ${line}`)
    for (const waiter of [...waiters]) {
      if (waiter.pattern.test(line)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(line)
      }
    }
  }
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = ''
    stream?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onLine(line)
    })
  }
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return {
    child,
    output,
    exited,
    waitFor(pattern, timeoutMs) {
      const already = output.find((line) => pattern.test(line))
      if (already) return Promise.resolve(already)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern} from ${label}`)), timeoutMs)
        waiters.push({
          pattern,
          resolve: (line) => {
            clearTimeout(timer)
            resolve(line)
          },
        })
      })
    },
  }
}

const controlPort = () => env('T3_CONTROL_PORT', '3601')

export async function control<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${controlPort()}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(`control ${method} ${path} failed: ${json.error ?? response.status}`)
  return json
}

export const STORE_ERROR = /Invalid resource handle|Failed to process message|SHUTDOWN_ERROR|UNHANDLED_REJECTION/
