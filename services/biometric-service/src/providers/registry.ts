import { z } from 'zod'

import type { BiometricServiceConfig } from '../config.ts'
import { createAwsRekognitionProvider } from './aws-rekognition.ts'
import { mockProvider } from './mock.ts'
import type { BiometricProvider } from './types.ts'

/** Providers offered by this deployment. aws-rekognition needs 12id's AWS principal; mock needs the explicit flag. */
export function buildRegistry(config: BiometricServiceConfig, extra: BiometricProvider[] = []): Map<string, BiometricProvider> {
  const providers: BiometricProvider[] = [...extra]
  if (config.BIOMETRIC_AWS_ACCESS_KEY_ID && config.BIOMETRIC_AWS_SECRET_ACCESS_KEY) {
    providers.push(createAwsRekognitionProvider({
      accessKeyId: config.BIOMETRIC_AWS_ACCESS_KEY_ID,
      secretAccessKey: config.BIOMETRIC_AWS_SECRET_ACCESS_KEY,
      stsRegion: config.BIOMETRIC_AWS_REGION,
    }))
  }
  if (config.BIOMETRIC_ENABLE_MOCK) providers.push(mockProvider)
  return new Map(providers.map((provider) => [provider.id, provider]))
}

export function catalogueEntry(provider: BiometricProvider) {
  return {
    id: provider.id,
    displayName: provider.displayName,
    configSchema: z.toJSONSchema(provider.configSchema) as Record<string, unknown>,
    captureModule: provider.captureModule,
  }
}
