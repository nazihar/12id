import { type Logger, LogLevel } from '@credo-ts/core'

/**
 * Credo's bundled ConsoleLogger produced no output in Phase 0, which made the first
 * silent stall much harder to diagnose than it needed to be. This one just prints.
 *
 * Note: Node's strip-only TypeScript mode rejects constructor parameter properties,
 * so the fields are declared explicitly.
 */
export class PlainLogger implements Logger {
  public logLevel: LogLevel
  private label: string

  public constructor(logLevel: LogLevel = LogLevel.Debug, label = '') {
    this.logLevel = logLevel
    this.label = label
  }

  private log(level: string, message: string, data?: Record<string, unknown>) {
    let suffix = ''
    if (data) {
      try {
        suffix = ` ${JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 600)}`
      } catch {
        suffix = ' [unserializable]'
      }
    }
    console.log(`[${level}]${this.label ? ` ${this.label}` : ''} ${message}${suffix}`)
  }

  public test(m: string, d?: Record<string, unknown>) { if (this.logLevel <= LogLevel.Test) this.log('test', m, d) }
  public trace(m: string, d?: Record<string, unknown>) { if (this.logLevel <= LogLevel.Trace) this.log('trace', m, d) }
  public debug(m: string, d?: Record<string, unknown>) { if (this.logLevel <= LogLevel.Debug) this.log('debug', m, d) }
  public info(m: string, d?: Record<string, unknown>) { if (this.logLevel <= LogLevel.Info) this.log('info', m, d) }
  public warn(m: string, d?: Record<string, unknown>) { if (this.logLevel <= LogLevel.Warn) this.log('warn', m, d) }
  public error(m: string, d?: Record<string, unknown>) { if (this.logLevel <= LogLevel.Error) this.log('error', m, d) }
  public fatal(m: string, d?: Record<string, unknown>) { if (this.logLevel <= LogLevel.Fatal) this.log('fatal', m, d) }
}
