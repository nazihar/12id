import { type Logger as CredoLogger, LogLevel } from '@credo-ts/core'
import { type DestinationStream, type Logger as PinoLogger, destination as fileDestination, pino, stdSerializers } from 'pino'

/**
 * Structured logger for both our code and Credo (D4). Credo's bundled ConsoleLogger printed
 * nothing on 0.7 (Phase 0), which is what made silent stalls so hard to localise.
 *
 * `destination` defaults to stdout; tests pass a stream to capture output.
 */
export function createServiceLogger(options: { name: string; level?: string; destination?: DestinationStream }): PinoLogger {
  return pino(
    {
      name: options.name,
      level: options.level ?? 'info',
      serializers: { err: stdSerializers.err },
      // Defensive: never let a store key or password reach a log line, whoever logs the object.
      redact: {
        paths: ['key', 'password', 'storeKey', '*.key', '*.password', '*.storeKey', '*.*.key', '*.*.password'],
        censor: '[redacted]',
      },
    },
    options.destination ?? fileDestination(1)
  )
}

const pinoToCredo: Record<string, LogLevel> = {
  trace: LogLevel.Trace,
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warn,
  error: LogLevel.Error,
  fatal: LogLevel.Fatal,
  silent: LogLevel.Off,
}

type LogData = Record<string, unknown> | undefined

/** Credo passes errors as `{ error }`; pino's error serializer is keyed on `err`. */
function toFields(data: LogData): Record<string, unknown> {
  if (!data) return {}
  if (!('error' in data)) return data
  const { error, ...rest } = data
  return { ...rest, err: error }
}

/** Adapts a pino logger to Credo's Logger interface. Pass a child logger to tag a component. */
export class PinoCredoLogger implements CredoLogger {
  private readonly pino: PinoLogger

  public constructor(pinoLogger: PinoLogger) {
    this.pino = pinoLogger
  }

  /** Follows the pino level, so Credo skips building debug payloads that would be dropped. */
  public get logLevel(): LogLevel {
    return pinoToCredo[this.pino.level] ?? LogLevel.Info
  }

  public test(message: string, data?: Record<string, unknown>) {
    if (this.logLevel <= LogLevel.Test) this.pino.trace({ ...toFields(data), credoLevel: 'test' }, message)
  }
  public trace(message: string, data?: Record<string, unknown>) {
    if (this.logLevel <= LogLevel.Trace) this.pino.trace(toFields(data), message)
  }
  public debug(message: string, data?: Record<string, unknown>) {
    if (this.logLevel <= LogLevel.Debug) this.pino.debug(toFields(data), message)
  }
  public info(message: string, data?: Record<string, unknown>) {
    if (this.logLevel <= LogLevel.Info) this.pino.info(toFields(data), message)
  }
  public warn(message: string, data?: Record<string, unknown>) {
    if (this.logLevel <= LogLevel.Warn) this.pino.warn(toFields(data), message)
  }
  public error(message: string, data?: Record<string, unknown>) {
    if (this.logLevel <= LogLevel.Error) this.pino.error(toFields(data), message)
  }
  public fatal(message: string, data?: Record<string, unknown>) {
    if (this.logLevel <= LogLevel.Fatal) this.pino.fatal(toFields(data), message)
  }
}
