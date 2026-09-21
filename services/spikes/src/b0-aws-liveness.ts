// Phase 6 B0 spike (12id/implement/16-phase-6-biometric.md): AWS Rekognition Face Liveness from a non-AWS host.
// Throwaway; results go to 12id/implement/17-phase-6-biometric-findings.md.
//
//   node --env-file=.aws-spike.env src/b0-aws-liveness.ts setup
//   node --env-file=.aws-spike.env src/b0-aws-liveness.ts session
//   node --env-file=.aws-spike.env src/b0-aws-liveness.ts results <sessionId> [out.jpg]
//   node --env-file=.aws-spike.env src/b0-aws-liveness.ts compare <reference.jpg> <probe.jpg>
//
// Never prints secret keys or session tokens.

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { GetRoleCommand, CreateRoleCommand, IAMClient, PutRolePolicyCommand, UpdateAssumeRolePolicyCommand } from '@aws-sdk/client-iam'
import {
  CompareFacesCommand,
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition'
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient, type Credentials } from '@aws-sdk/client-sts'

const region = process.env.AWS_REGION ?? 'ap-south-1'
const ROLE_NAME = '12id-biometric-spike-tenant'
const STATE_FILE = new URL('../.b0-state.local.json', import.meta.url)

type State = { roleArn: string; externalId: string }

const sts = new STSClient({ region })

function loadState(): State {
  if (!existsSync(STATE_FILE)) throw new Error('run `setup` first')
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State
}

function awsCreds(c: Credentials) {
  return { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! }
}

function errName(e: unknown) {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

// Tenant role as a tenant would create it: our principal may assume it only with our external id.
async function setup() {
  const me = await sts.send(new GetCallerIdentityCommand({}))
  console.log('caller', { account: me.Account, arn: me.Arn })

  const externalId = existsSync(STATE_FILE) ? loadState().externalId : `12id-${randomUUID()}`
  const trust = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { AWS: me.Arn }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'sts:ExternalId': externalId } } }],
  }
  const permissions = {
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Action: ['rekognition:CreateFaceLivenessSession', 'rekognition:GetFaceLivenessSessionResults', 'rekognition:StartFaceLivenessSession', 'rekognition:CompareFaces'],
      Resource: '*',
    }],
  }

  const iam = new IAMClient({ region })
  let roleArn: string
  try {
    roleArn = (await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }))).Role!.Arn!
    await iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: ROLE_NAME, PolicyDocument: JSON.stringify(trust) }))
    console.log('role exists, trust policy refreshed', roleArn)
  } catch (e) {
    if (!(e instanceof Error) || e.name !== 'NoSuchEntityException') throw e
    roleArn = (await iam.send(new CreateRoleCommand({
      RoleName: ROLE_NAME,
      AssumeRolePolicyDocument: JSON.stringify(trust),
      Description: '12id Phase 6 B0 spike: stands in for a tenant role',
      MaxSessionDuration: 3600,
    }))).Role!.Arn!
    console.log('role created', roleArn)
  }
  await iam.send(new PutRolePolicyCommand({ RoleName: ROLE_NAME, PolicyName: 'face-liveness', PolicyDocument: JSON.stringify(permissions) }))
  writeFileSync(STATE_FILE, JSON.stringify({ roleArn, externalId } satisfies State, null, 2))
  console.log('state written (role ARN + external id, no secrets)')
}

async function assumeTenant(sessionPolicy?: object, durationSeconds = 900): Promise<Credentials> {
  const { roleArn, externalId } = loadState()
  // A fresh role or trust policy takes a few seconds to propagate.
  for (let attempt = 1; ; attempt++) {
    try {
      const out = await sts.send(new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `12id-b0-${Date.now()}`,
        ExternalId: externalId,
        DurationSeconds: durationSeconds,
        Policy: sessionPolicy ? JSON.stringify(sessionPolicy) : undefined,
      }))
      return out.Credentials!
    } catch (e) {
      if (attempt >= 8) throw e
      console.log(`assume-role attempt ${attempt} failed (${errName(e)}), retrying`)
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
}

async function session() {
  const { roleArn, externalId } = loadState()

  // Without the external id the role must refuse (confused-deputy protection).
  try {
    await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: 'no-external-id' }))
    console.log('UNEXPECTED: assumed without external id')
  } catch (e) {
    console.log('assume without external id refused:', errName(e).split(':')[0])
  }
  try {
    await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: 'wrong-external-id', ExternalId: `${externalId}-x` }))
    console.log('UNEXPECTED: assumed with a wrong external id')
  } catch (e) {
    console.log('assume with wrong external id refused:', errName(e).split(':')[0])
  }

  const tenant = await assumeTenant()
  console.log('assumed tenant role; expires', tenant.Expiration?.toISOString())
  const rek = new RekognitionClient({ region, credentials: awsCreds(tenant) })

  const t0 = Date.now()
  const created = await rek.send(new CreateFaceLivenessSessionCommand({
    ClientRequestToken: randomUUID(),
    Settings: { AuditImagesLimit: 0 }, // no OutputConfig: nothing is written to S3
  }))
  console.log('liveness session created', { sessionId: created.SessionId, ms: Date.now() - t0 })

  const before = await rek.send(new GetFaceLivenessSessionResultsCommand({ SessionId: created.SessionId }))
  console.log('results before streaming', { status: before.Status, confidence: before.Confidence, hasReference: !!before.ReferenceImage?.Bytes })

  // Device credentials: same role, session policy narrowed to streaming only, 15 min.
  const devicePolicy = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: 'rekognition:StartFaceLivenessSession', Resource: '*' }],
  }
  const device = await assumeTenant(devicePolicy, 900)
  console.log('device credentials vended; expires', device.Expiration?.toISOString())
  const deviceRek = new RekognitionClient({ region, credentials: awsCreds(device) })
  for (const [label, cmd] of [
    ['CreateFaceLivenessSession', new CreateFaceLivenessSessionCommand({ ClientRequestToken: randomUUID() })],
    ['GetFaceLivenessSessionResults', new GetFaceLivenessSessionResultsCommand({ SessionId: created.SessionId })],
  ] as const) {
    try {
      await deviceRek.send(cmd as never)
      console.log(`UNEXPECTED: device credentials could call ${label}`)
    } catch (e) {
      console.log(`device credentials refused ${label}:`, errName(e).split(':')[0])
    }
  }
  console.log('\nstream to this session from the phone, then run: results', created.SessionId)
}

async function results(sessionId: string, out?: string) {
  const tenant = await assumeTenant()
  const rek = new RekognitionClient({ region, credentials: awsCreds(tenant) })
  const r = await rek.send(new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId }))
  console.log('results', {
    status: r.Status,
    confidence: r.Confidence,
    referenceBytes: r.ReferenceImage?.Bytes?.length ?? 0,
    referenceS3: r.ReferenceImage?.S3Object ?? null,
    auditImages: r.AuditImages?.length ?? 0,
    boundingBox: r.ReferenceImage?.BoundingBox,
  })
  if (out && r.ReferenceImage?.Bytes) {
    writeFileSync(out, r.ReferenceImage.Bytes)
    console.log('reference image written to', out)
  }
}

async function compare(referencePath: string, probePath: string) {
  const tenant = await assumeTenant()
  const rek = new RekognitionClient({ region, credentials: awsCreds(tenant) })
  const t0 = Date.now()
  const r = await rek.send(new CompareFacesCommand({
    SourceImage: { Bytes: readFileSync(referencePath) },
    TargetImage: { Bytes: readFileSync(probePath) },
    SimilarityThreshold: 0, // return every candidate; the platform applies its own threshold
  }))
  console.log('compare', {
    ms: Date.now() - t0,
    matches: r.FaceMatches?.map((m) => m.Similarity),
    unmatched: r.UnmatchedFaces?.length ?? 0,
    sourceConfidence: r.SourceImageFace?.Confidence,
  })
}

const [cmd, a, b] = process.argv.slice(2)
try {
  if (cmd === 'setup') await setup()
  else if (cmd === 'session') await session()
  else if (cmd === 'results' && a) await results(a, b)
  else if (cmd === 'compare' && a && b) await compare(a, b)
  else console.log('usage: setup | session | results <sessionId> [out.jpg] | compare <reference> <probe>')
} catch (e) {
  console.error('FAILED', errName(e))
  process.exitCode = 1
}
