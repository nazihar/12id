/**
 * AWS Rekognition Face Liveness + CompareFaces (16-phase-6-biometric.md B1).
 *
 * Bring your own account: the tenant creates a role that trusts 12id's principal with our
 * per-tenant external id. We assume it for every server call. The device gets separate
 * credentials from the same role, narrowed by a session policy to StartFaceLivenessSession.
 *
 * No OutputConfig on CreateFaceLivenessSession, so AWS writes nothing to S3; the reference image
 * comes back in GetFaceLivenessSessionResults and is never stored by us.
 */
import { randomUUID } from 'node:crypto'

import {
  CompareFacesCommand,
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition'
import { AssumeRoleCommand, type Credentials, STSClient } from '@aws-sdk/client-sts'
import { z } from 'zod'

import { type BiometricProvider, type ProviderContext, ProviderError } from './types.ts'

/** Regions that offer Face Liveness (AWS docs, 2026). Validated so a typo fails at configuration time. */
export const FACE_LIVENESS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-2', 'ap-south-1', 'ap-northeast-1', 'ap-northeast-2',
  'ap-southeast-1', 'ap-southeast-2', 'ca-central-1', 'eu-central-1', 'eu-west-1', 'eu-west-2',
] as const

const configSchema = z
  .object({
    region: z.enum(FACE_LIVENESS_REGIONS),
    roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/[\w+=,.@\/-]{1,512}$/, 'must be an IAM role ARN'),
  })
  .strict()

const DEVICE_SESSION_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 'rekognition:StartFaceLivenessSession', Resource: '*' }],
})

/** AssumeRole's minimum; the device only needs it for one capture. */
const DEVICE_CREDENTIAL_SECONDS = 900

export interface AwsProviderOptions {
  /** 12id's own principal (SOPS). */
  accessKeyId: string
  secretAccessKey: string
  stsRegion: string
  /** Test seam. */
  clients?: {
    sts?: { send(command: AssumeRoleCommand): Promise<{ Credentials?: Credentials }> }
    rekognition?: (region: string, credentials: Credentials) => { send(command: never): Promise<any> }
  }
}

function asAwsCredentials(c: Credentials) {
  return { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken!, expiration: c.Expiration }
}

function awsError(error: unknown): ProviderError {
  const name = (error as { name?: string })?.name ?? 'Error'
  const message = (error as { message?: string })?.message ?? String(error)
  if (name === 'AccessDenied' || name === 'AccessDeniedException') return new ProviderError('access_denied', `${name}: ${message}`)
  return new ProviderError('vendor_error', `${name}: ${message}`)
}

export function createAwsRekognitionProvider(options: AwsProviderOptions): BiometricProvider {
  const sts = options.clients?.sts ?? new STSClient({
    region: options.stsRegion,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  })
  const rekognitionFor = options.clients?.rekognition
    ?? ((region: string, credentials: Credentials) => new RekognitionClient({ region, credentials: asAwsCredentials(credentials), maxAttempts: 2 }))

  // Server-side tenant credentials, reused until five minutes before they expire.
  const cache = new Map<string, Credentials>()

  async function assume(ctx: ProviderContext, sessionPolicy?: string, durationSeconds = 3600): Promise<Credentials> {
    const { roleArn } = configSchema.parse(ctx.config)
    try {
      const out = await sts.send(new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `12id-${ctx.tenantId}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 64),
        ExternalId: ctx.externalId,
        DurationSeconds: durationSeconds,
        Policy: sessionPolicy,
      }))
      if (!out.Credentials) throw new Error('AssumeRole returned no credentials')
      return out.Credentials
    } catch (error) {
      throw awsError(error)
    }
  }

  async function tenantClient(ctx: ProviderContext) {
    const { region, roleArn } = configSchema.parse(ctx.config)
    const key = `${ctx.tenantId}|${roleArn}|${ctx.externalId}`
    let credentials = cache.get(key)
    if (!credentials || !credentials.Expiration || credentials.Expiration.getTime() - Date.now() < 5 * 60_000) {
      credentials = await assume(ctx)
      cache.set(key, credentials)
    }
    return rekognitionFor(region, credentials)
  }

  async function call<T>(ctx: ProviderContext, command: unknown): Promise<T> {
    const client = await tenantClient(ctx)
    try {
      return await client.send(command as never)
    } catch (error) {
      throw awsError(error)
    }
  }

  return {
    id: 'aws-rekognition',
    displayName: 'AWS Rekognition Face Liveness',
    configSchema,
    captureModule: { provider: 'aws-rekognition', minVersion: 1 },
    publicConfig: (config) => {
      const { region, roleArn } = configSchema.parse(config)
      return { region, roleArn }
    },

    async testConnection(ctx) {
      cache.clear()
      await call(ctx, new CreateFaceLivenessSessionCommand({ ClientRequestToken: randomUUID(), Settings: { AuditImagesLimit: 0 } }))
    },

    async createSession(ctx) {
      const { region } = configSchema.parse(ctx.config)
      const created = await call<{ SessionId?: string }>(ctx, new CreateFaceLivenessSessionCommand({
        ClientRequestToken: randomUUID(),
        Settings: { AuditImagesLimit: 0 },
      }))
      if (!created.SessionId) throw new ProviderError('vendor_error', 'CreateFaceLivenessSession returned no SessionId')
      const device = await assume(ctx, DEVICE_SESSION_POLICY, DEVICE_CREDENTIAL_SECONDS)
      return {
        vendorSessionId: created.SessionId,
        clientConfig: {
          sessionId: created.SessionId,
          region,
          credentials: {
            accessKeyId: device.AccessKeyId,
            secretAccessKey: device.SecretAccessKey,
            sessionToken: device.SessionToken,
            expiration: device.Expiration?.toISOString(),
          },
        },
      }
    },

    async completeSession(ctx, input) {
      const r = await call<{
        Status?: string
        Confidence?: number
        ReferenceImage?: { Bytes?: Uint8Array; BoundingBox?: unknown }
      }>(ctx, new GetFaceLivenessSessionResultsCommand({ SessionId: input.vendorSessionId }))
      const raw = { status: r.Status ?? null, confidence: r.Confidence ?? null, boundingBox: r.ReferenceImage?.BoundingBox ?? null }
      switch (r.Status) {
        case 'SUCCEEDED': {
          const bytes = r.ReferenceImage?.Bytes
          if (!bytes || bytes.length === 0) return { status: 'failed', reason: 'vendor_failed', raw: { ...raw, note: 'no reference image returned' } }
          return { status: 'ready', livenessScore: r.Confidence ?? 0, probeImage: Buffer.from(bytes), raw }
        }
        case 'FAILED':
          return { status: 'failed', reason: 'vendor_failed', raw }
        case 'EXPIRED':
          return { status: 'failed', reason: 'vendor_expired', raw }
        default: // CREATED, IN_PROGRESS
          return { status: 'pending' }
      }
    },

    async matchFaces(ctx, reference, probe) {
      try {
        const r = await call<{ FaceMatches?: { Similarity?: number }[]; UnmatchedFaces?: unknown[]; SourceImageFace?: { Confidence?: number } }>(
          ctx,
          new CompareFacesCommand({ SourceImage: { Bytes: reference }, TargetImage: { Bytes: probe }, SimilarityThreshold: 0 })
        )
        const best = Math.max(0, ...(r.FaceMatches ?? []).map((m) => m.Similarity ?? 0))
        return {
          matchScore: (r.FaceMatches?.length ?? 0) + (r.UnmatchedFaces?.length ?? 0) === 0 ? null : best,
          raw: { matches: r.FaceMatches?.length ?? 0, unmatched: r.UnmatchedFaces?.length ?? 0, sourceConfidence: r.SourceImageFace?.Confidence ?? null },
        }
      } catch (error) {
        // CompareFaces reports "no face in the source image" as InvalidParameterException.
        if (error instanceof ProviderError && /InvalidParameterException/.test(error.message)) {
          return { matchScore: null, raw: { error: 'no face detected' } }
        }
        throw error
      }
    },
  }
}
