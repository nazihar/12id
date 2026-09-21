import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createAwsRekognitionProvider } from '../src/providers/aws-rekognition.ts'
import { ProviderError } from '../src/providers/types.ts'

const config = { region: 'ap-south-1', roleArn: 'arn:aws:iam::123456789012:role/tenant-face' }
const ctx = { tenantId: 'tenant-a', config, externalId: '12id-ext' }

function stubbed(rekognitionReply: (name: string, input: any) => any) {
  const assumed: any[] = []
  const sent: { name: string; input: any }[] = []
  const provider = createAwsRekognitionProvider({
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    stsRegion: 'ap-south-1',
    clients: {
      sts: {
        async send(command) {
          assumed.push(command.input)
          return { Credentials: { AccessKeyId: 'ASIA', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 3_600_000) } }
        },
      },
      rekognition: () => ({
        async send(command: any) {
          const name = command.constructor.name as string
          sent.push({ name, input: command.input })
          return rekognitionReply(name, command.input)
        },
      }),
    },
  })
  return { provider, assumed, sent }
}

describe('aws-rekognition provider', () => {
  it('validates configuration: known region, role ARN, nothing else', () => {
    const { provider } = stubbed(() => ({}))
    assert.equal(provider.configSchema.safeParse(config).success, true)
    assert.equal(provider.configSchema.safeParse({ ...config, region: 'mars-1' }).success, false)
    assert.equal(provider.configSchema.safeParse({ ...config, roleArn: 'arn:aws:iam::1:user/x' }).success, false)
    assert.equal(provider.configSchema.safeParse({ ...config, secretAccessKey: 'x' }).success, false)
  })

  it('creates a session without S3 output and vends device credentials limited to streaming', async () => {
    const { provider, assumed, sent } = stubbed((name) => (name === 'CreateFaceLivenessSessionCommand' ? { SessionId: 'sess-1' } : {}))
    const created = await provider.createSession(ctx, { checkId: 'c', attempt: 1 })

    const create = sent.find((s) => s.name === 'CreateFaceLivenessSessionCommand')!
    assert.equal(create.input.Settings.OutputConfig, undefined)
    assert.equal(create.input.Settings.AuditImagesLimit, 0)

    assert.ok(assumed.every((a) => a.ExternalId === '12id-ext' && a.RoleArn === config.roleArn))
    const device = assumed.find((a) => a.Policy)!
    assert.equal(device.DurationSeconds, 900)
    assert.deepEqual(JSON.parse(device.Policy).Statement[0].Action, 'rekognition:StartFaceLivenessSession')

    const clientConfig = created.clientConfig as any
    assert.equal(created.vendorSessionId, 'sess-1')
    assert.equal(clientConfig.region, 'ap-south-1')
    assert.equal(clientConfig.credentials.accessKeyId, 'ASIA')
  })

  it('maps result statuses', async () => {
    const replies: Record<string, any> = {
      done: { Status: 'SUCCEEDED', Confidence: 96.5, ReferenceImage: { Bytes: new Uint8Array([1, 2, 3]) } },
      noImage: { Status: 'SUCCEEDED', Confidence: 96.5 },
      busy: { Status: 'IN_PROGRESS' },
      failed: { Status: 'FAILED' },
      expired: { Status: 'EXPIRED' },
    }
    for (const [key, reply] of Object.entries(replies)) {
      const { provider } = stubbed(() => reply)
      const outcome = await provider.completeSession(ctx, { vendorSessionId: 's', clientOutput: {} })
      if (key === 'done') {
        assert.equal(outcome.status, 'ready')
        assert.equal(outcome.status === 'ready' && outcome.livenessScore, 96.5)
        assert.equal(outcome.status === 'ready' && JSON.stringify(outcome.raw).includes('"1"'), false, 'raw must not carry image bytes')
      }
      if (key === 'noImage') assert.deepEqual([outcome.status, outcome.status === 'failed' && outcome.reason], ['failed', 'vendor_failed'])
      if (key === 'busy') assert.equal(outcome.status, 'pending')
      if (key === 'failed') assert.equal(outcome.status === 'failed' && outcome.reason, 'vendor_failed')
      if (key === 'expired') assert.equal(outcome.status === 'failed' && outcome.reason, 'vendor_expired')
    }
  })

  it('takes the best similarity; no face at all is null', async () => {
    const { provider, sent } = stubbed(() => ({ FaceMatches: [{ Similarity: 88 }, { Similarity: 99.1 }], UnmatchedFaces: [] }))
    assert.equal((await provider.matchFaces(ctx, Buffer.from('r'), Buffer.from('p'))).matchScore, 99.1)
    assert.equal(sent[0]!.input.SimilarityThreshold, 0)

    const unmatched = stubbed(() => ({ FaceMatches: [], UnmatchedFaces: [{}] }))
    assert.equal((await unmatched.provider.matchFaces(ctx, Buffer.from('r'), Buffer.from('p'))).matchScore, 0)

    const noFace = stubbed(() => {
      throw Object.assign(new Error('Requested image should contain a face'), { name: 'InvalidParameterException' })
    })
    assert.equal((await noFace.provider.matchFaces(ctx, Buffer.from('r'), Buffer.from('p'))).matchScore, null)
  })

  it('reports access denied as a provider error', async () => {
    const { provider } = stubbed(() => {
      throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' })
    })
    await assert.rejects(provider.testConnection(ctx), (e: unknown) => e instanceof ProviderError && e.code === 'access_denied')
  })
})
