import { type DestinationStream, type Logger, destination as fileDestination, pino, stdSerializers } from 'pino'

/**
 * pino with biometric redaction. Images, capture output, vendor configuration and credentials must
 * never reach a log line, whoever logs the object (16-phase-6-biometric.md B1 "Logging").
 * No @credo-ts dependency: this service has no agent.
 */
export const REDACTED_PATHS = [
  'referenceImage', '*.referenceImage',
  'probeImage', '*.probeImage',
  'clientOutput', '*.clientOutput',
  'clientConfig', '*.clientConfig',
  'config', '*.config',
  'credentials', '*.credentials', '*.*.credentials',
  'secretAccessKey', '*.secretAccessKey', '*.*.secretAccessKey',
  'sessionToken', '*.sessionToken', '*.*.sessionToken',
  'req.body', 'body', '*.body',
  'key', '*.key', 'password', '*.password',
]

export function createLogger(options: { name: string; level?: string; destination?: DestinationStream }): Logger {
  return pino(
    {
      name: options.name,
      level: options.level ?? 'info',
      serializers: { err: stdSerializers.err },
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    },
    options.destination ?? fileDestination(1)
  )
}
