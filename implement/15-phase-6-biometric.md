# Phase 6 — Biometric gate: liveness + face match (plan)

**Status (2026-09-21):** built and on staging. `smoke:biometric-credo` (mock) 18/18 and `smoke:sdk-biometric-android` (mock, phone) 12/12 passed. The AWS half waits for the owner's tenant role. As-built differences and evidence are in [`16-phase-6-biometric-findings.md`](16-phase-6-biometric-findings.md).

## Context
Phases 0–5 (Android) are done and on staging (`12id/implement/1…14`):
- ledger, patched mediator, agent-service + endorser-service, platform-api (API keys, wallet tokens, webhooks, wake path), console (operator + tenant portal, dashboards), and the Android holder SDK (`com.12id:holder-sdk-android`, `com.onetwoid.sdk.OneTwoId`).
- The pre-production review is written (now [`17-phase-7.md`](17-phase-7.md), Phase 7); none of its fixes are built.

Phase 6 adds an **optional, per-tenant biometric gate**. The end user must pass **liveness** plus a **face match** against a reference image the tenant supplies before:
- a credential is **issued**, or
- a proof result is **released** to the tenant.

It is a third-party integration the platform owns:
- The tenant enables it and configures its own vendor account.
- The tenant sets the requirement and minimum scores per credential definition and per proof template.
- The tenant never writes vendor code.
- Vendors are swappable behind ports.

**Outcome:** gated issuance and gated proofs work end to end on staging with **AWS Rekognition Face Liveness**. The biometric log is visible per exchange in the console. Gate: `smoke:biometric-credo` and `smoke:sdk-biometric-android` pass.

## Decisions (this session)
| Item | Decision | Consequence |
|---|---|---|
| Phase placement | **Phase 6**, after the SDK and before the review fix set | The review becomes **Phase 7** (`15-phase-6.md` → `17-phase-7.md`), and the former Hardening becomes **Phase 8** |
| Server placement | New internal **`biometric-service`** with its own encryption key; platform-api owns policy, the gate and every public route | Vendor SDKs, vendor credentials and face images stay out of the customer-facing process |
| Database | A `biometric` database on the **shared `agent-postgres`** instance, backed up like the other databases | Acceptable because images live about 30 minutes and are encrypted with a key that is not in the database. A scoped role comes with H3 (Phase 7). A dedicated instance only if production moves to instance-level backups or H3 cannot isolate it. *Phase 7 update (2026-09-22): the scoped role `biometric` is in place (H3)* |
| Vendor accounts | **Bring your own only** | Each tenant configures its own AWS account. We hold no vendor billing relationship |
| Vendors this phase | **AWS Rekognition Face Liveness**, tested with the owner's existing AWS account, plus a `mock` provider | FaceTec and an in-house provider are later phases; the ports are designed for them now |
| Reference image | **Per request** (sent with the offer or proof request), deleted at decision time | Nothing biometric persists on our side beyond scores and decisions |
| Device capture | **Native add-ons**, platform-specific, named after the core SDK | Android: `com.12id:holder-sdk-android-biometrics-aws`. iOS mirrors it in Phase 5-iOS. Switching vendor later needs the tenant's app to ship the new add-on |
| Audit | Biometric log shown per exchange in the console exchanges list (tenant + operator) | Log rows carry scores, decisions and AWS session ids, never images |
| Log retention | **No automatic deletion in this phase** | Left to the Phase 7 retention work (H1), which must include the biometric tables. *Phase 7 update (2026-09-28): done. Scores and vendor session ids in `exchange_gates`/`exchange_gate_events` and biometric-service's check (new `POST /checks/:id/erase`, migration `0001_erasure`) are scrubbed with the exchange by retention or on request; decisions stay* |

## Facts this plan builds on (verified while planning, source read)
- **No hold point today.** agent-service runs with global `autoAcceptCredentials` / `autoAcceptProofs: ContentApproved` (`agent/root-agent.ts`). A matching credential request is issued at once, and a presentation is verified and acked at once. Credo takes a **per-record** override on `offerCredential` / `requestProof`. With `Never` the record parks at `request-received` / `presentation-received`, and the outbox already emits that transition with its thread id.
- **The reconciler would leave held records forever.** `exchanges/reconcile.ts` abandons only `OfferSent`, `CredentialIssued` and `RequestSent` after `RECONCILE_TTL_MS`.
- **For proofs, the holder has already revealed the data at `presentation-received`.** The proof gate therefore controls what the **tenant** receives (`verified`, `disclosed`), not what the holder sent. The SDK runs the check before responding, so honest apps never present first.
- **Commands go straight to the agent.** `POST /v1/credentials/offer` and `POST /v1/proofs/request` (`http/routes/exchanges.ts`) call the agent inside the request and upsert the mirror row with the returned `record_id` and `thread_id`. There is no pre-agent state.
- **Thread id is the shared key.** platform-api stores `thread_id` on `connections`, `credentials` and `proofs` (no index). The SDK's Aries records carry the same thread id (v1 holder thread = issuer thread) but no public model exposes it; `exchangeIdForThread` exists internally.
- **No wallet ↔ connection link.** `wallets` only knows its mediator ids. Binding a biometric session to an exchange must rest on the thread id plus a same-tenant wallet token.
- **No per-tenant settings or encryption helper** exists in platform-api. The webhook secret is plaintext by design; API keys and wallet tokens are sha256 hashes.
- **`EVENT_TYPES`** (`webhooks/events.ts`) is a closed tuple reused by the webhook subscription enum.
- **The SDK already waits for the host app:** `autoAcceptCredential = Never`, `autoAcceptProof = Never`. `acceptOffer` stamps `Always` on the record. `OneTwoIdException` is sealed. `PlatformClient` (OkHttp) calls only `/v1/ledger` and `/v1/wallet/mediator-invitation`.
- **The console's exchanges tables are shared.** `ExchangeTables` (`features/tenant-data/panels.tsx`) renders both `t/$orgSlug/exchanges.tsx` and `ops/tenants/$tenantId/exchanges.tsx`. `DeliveriesPanel` already has a row-detail dialog to copy.
- **Backups** are per-database `pg_dump | age` from a fixed list in `infra/scripts/backup-postgres.sh`, with 7-day retention.

---

## Workstreams

### B0 — Spike (first; gate for B1 and B4)
On the Xiaomi (Android 14, arm64) with the owner's AWS account. Record in `16-phase-6-biometric-findings.md`:
- **Amplify UI Face Liveness on Android.** Confirm and record:
  - that `FaceLivenessDetector` accepts an injected credentials provider (no Cognito, no `amplifyconfiguration.json`);
  - that it can be hosted in a plain `ComponentActivity` owned by the add-on, so the host app need not use Compose;
  - its minSdk, the APK size delta (arm64 release), and R8 coexistence with the SDK's consumer rules.
- **Session flow from a non-AWS host.**
  - From a workstation, run `sts:AssumeRole` (with an external id) into a role in the owner's account.
  - Then `CreateFaceLivenessSession` with **no `OutputConfig`**, and check that `GetFaceLivenessSessionResults` returns Confidence and the **ReferenceImage bytes** with no S3 bucket.
  - Then find the narrowest session policy under which the device can call `StartFaceLivenessSession` with vended STS credentials.
- **`CompareFaces`.** Similarity for same person versus different person, using a phone-camera reference image and an ID-style photo. This gives the default `minMatchScore`.
- **Attack sanity.** A printed photo and a screen replay against liveness, recording Confidence.
- **Region.** Face Liveness is only offered in some regions; record which one we use.

Nothing is committed to the repo from B0 except the findings, unless it becomes the add-on.

### B1 — `services/biometric-service` (new)
Same conventions as `endorser-service`: Fastify + zod, drizzle, plain `node`, pino, a shared error handler, graceful shutdown, and `/healthz`.

- **Network and auth:** private network shared only with platform-api, its own `BIOMETRIC_INTERNAL_TOKEN` (not the agent token; H2 lesson), and outbound HTTPS to AWS.
- **Database:** `biometric` on `agent-postgres` (`DATABASE_URL=…@agent-postgres:5432/biometric`, as `postgres` until H3). It is created and migrated by a one-shot provision step, like `agent-provision`. Migrations are `drizzle/0000_init.sql`.
  > **Phase 7 update (2026-09-22, review H3):** done. biometric-service connects as its own role `biometric`, which owns only the `biometric` database. No other service role can connect to it. `smoke:biometric-credo` passed 18/18 after the change. There is no dedicated instance (owner decision). See [`17-phase-7.md`](17-phase-7.md) H3.
- **Encryption:** envelope encryption. `BIOMETRIC_MASTER_KEY` (SOPS) wraps one random per-tenant data key. AES-256-GCM, with the tenant id plus the row id as AAD, encrypts:
  - provider config (role ARN and external id, or, as a fallback, access keys);
  - reference images.
- **Tables:**
  - `tenant_keys`: tenant, wrapped DEK, created.
  - `provider_configs`: tenant, provider id, encrypted config, status (`untested|ok|failed`), last test at/result.
  - `checks`: id, tenant, purpose (`issue|proof`), thresholds snapshot, encrypted reference image (nullable after wipe), reference sha256, status (`pending|passed|failed|expired`), attempts, max attempts, expires_at.
  - `sessions`: id, check, attempt no, vendor session id, status, started/completed at.
  - `results`: session, normalized liveness and match scores, raw vendor values (jsonb), decision, reason, probe sha256.
- **Port:**
  ```ts
  interface BiometricProvider {
    id: string                                   // 'aws-rekognition' | 'mock' in this phase
    configSchema: JsonSchema                     // console renders the provider form from it
    captureModule: { provider: string, minVersion: number }   // which device add-on can run it
    testConnection(cfg): Promise<void>
    createSession(cfg, check): Promise<{ vendorSessionId: string, clientConfig: unknown }>
    completeSession(cfg, session, clientOutput): Promise<{ live: boolean, livenessScore: number, probeImage: Uint8Array, matchScore?: number, raw: unknown }>
    matchFaces(cfg, reference: Uint8Array, probe: Uint8Array): Promise<{ matchScore: number, raw: unknown }>
  }
  ```
  Scores are normalized to 0–100; AWS Confidence and Similarity already are. A later vendor adds an adapter here plus an add-on per platform, and nothing else changes.
- **Adapters:**
  - **`mock`:** `clientOutput: { live: boolean, face: string }`, and a match scores 99 when `face` equals the reference's sha256 prefix, otherwise 10. Used by tests, `smoke:biometric-credo` and the console spec. It is available only when `BIOMETRIC_ENABLE_MOCK=true` (staging and tests, never production).
  - **`aws-rekognition`** (every call confirmed in B0):
    - Config `{ region, roleArn }`; `externalId` is generated by us per tenant and shown in the console.
    - `sts:AssumeRole` uses the 12id principal (`BIOMETRIC_AWS_ACCESS_KEY_ID`/`_SECRET`, SOPS).
    - `createSession` → `CreateFaceLivenessSession` (no `OutputConfig`). It also vends device credentials: `AssumeRole` with a session policy allowing only `rekognition:StartFaceLivenessSession`, 15 minutes.
    - `clientConfig = { sessionId, region, credentials }`.
    - `completeSession` → `GetFaceLivenessSessionResults` (status `SUCCEEDED`, Confidence, ReferenceImage bytes). `matchFaces` → `CompareFaces(Source = tenant reference, Target = liveness reference)`. No face in either image counts as a fail with reason `no_face`.
    - `testConnection` → `AssumeRole` + `CreateFaceLivenessSession`, and the session is left to expire.
- **Decision** (in the service, not the adapter): `passed` requires live, liveness ≥ `minLivenessScore` and match ≥ `minMatchScore`. After each attempt the probe image is dropped from memory. At the decision (`passed`, or `failed` with no attempts left) the reference image is wiped (`NULL` + sha kept).
- **Internal API:**
  - `GET /providers`, the catalogue: id, `configSchema`, `captureModule`.
  - `PUT/GET/DELETE /tenants/:t/provider`. GET never returns secrets, only non-secret fields and status. PUT validates against `configSchema`.
  - `POST /tenants/:t/provider/test`.
  - `POST /checks`: tenant, purpose, thresholds, reference image (base64, JPEG/PNG, ≤ 5 MB, at least one face is checked on the first attempt) → `{ checkId }`.
  - `POST /checks/:id/sessions` → `{ sessionId, provider, clientConfig, attempt }`. It returns 409 if the check is not pending or has no attempts left.
  - `POST /sessions/:id/complete {clientOutput}` → `{ decision, check: {status, attemptsRemaining}, scores, reason }`. It is single-use per session.
  - `GET /checks/:id`, and `DELETE /checks/:id` (wipe early, e.g. the exchange was abandoned).
- **Jobs:** every minute, expire checks past `expires_at` (status `expired`, image wiped). There is no purge of results this phase (Phase 7, H1).
- **Logging:** pino redaction for `referenceImage`, `probeImage`, `clientOutput`, `credentials` and `config`. No request-body logging on the check routes.

### B2 — agent-service
- `exchanges/exchanges.ts`: `offerCredential` / `requestProof` accept `autoAccept?: 'never'` → `autoAcceptCredential: DidCommAutoAcceptCredential.Never` / `autoAcceptProof: DidCommAutoAcceptProof.Never` on that record. The global setting stays `ContentApproved`.
- `http/command-routes.ts`, new routes:
  - `POST /tenants/:tenantId/credentials/:id/issue` → `credentials.acceptRequest`. 409 unless `request-received`.
  - `POST /tenants/:tenantId/credentials/:id/decline` → problem report + abandoned, with an outbox row.
  - `POST /tenants/:tenantId/proofs/:id/accept` → `proofs.acceptPresentation`. 409 unless `presentation-received`.
  - `POST /tenants/:tenantId/proofs/:id/decline` → problem report + abandoned.
- `exchanges/reconcile.ts`: add `RequestReceived` and `PresentationReceived` to the TTL-abandon list. The platform's gate TTL (30 min default) is shorter, so the platform normally declines first.
- Tests in `test/internal-api.test.ts` for each route and the per-record override.

### B3 — platform-api
- **Migration `0004_biometric`:**
  - `biometric_settings`: `tenant_id` PK, `enabled`, `provider_id`, `default_policy` jsonb, `updated_at`.
  - `credential_definition_policies`: (`tenant_id`, `credential_definition_id` catalogue id) PK, `biometric_policy` jsonb.
  - `proof_templates.biometric_policy` jsonb, nullable, kept outside `definition` so `expandTemplate` and `validateTemplate` are untouched.
  - `exchange_gates`: id, tenant, `record_type` (`credential|proof`), `record_id`, `thread_id`, `check_id`, status, attempts, max attempts, `expires_at`, `hold_reached_at`, `decided_at`, reason, `match_score`, `liveness_score`, `thresholds` jsonb. Unique (`tenant_id`, `record_type`, `record_id`) and an index on (`tenant_id`, `thread_id`).
  - `exchange_gate_events` (append-only, the audit log): bigserial id, gate id, tenant, at, type, attempt, provider, `liveness_score`, `match_score`, `thresholds`, decision, reason, `vendor_session_id`. Index on (`gate_id`, `id`).
  - `wallets.capture_modules text[]`.
  - Add all new tables to the cleanup list in `test/helpers.ts`.
- **Policy** (`src/biometric/policy.ts`):
  ```
  { mode: 'inherit'|'required'|'off', minMatchScore: 0–100, minLivenessScore: 0–100, maxAttempts: 1–5 (3), ttlMinutes: 5–1440 (30) }
  ```
  - For issuance: the cred-def policy, else the tenant default.
  - For proofs: the template's policy, else the tenant default. An inline `request` (no template) uses the tenant default.
  - The gate applies only if the tenant is `enabled` and its provider status is `ok`; `required` with the tenant disabled → 409 `biometric_not_configured`.
  - The thresholds are snapshotted into the check, so a later policy edit never changes a running check.
- **Customer API** (`http/routes/exchanges.ts`):
  - Both commands take an optional `biometric: { referenceImage: string }` (base64). The body limit is raised to 8 MB on these two routes only.
  - Required and missing → 422 `biometric_reference_required`. Present but not required → ignored and not stored.
  - Gated order of work: `POST /checks` → agent command with `autoAccept: 'never'` → mirror row + `exchange_gates` + `gate_created` event in one transaction. If the agent call fails, `DELETE /checks/:id`.
  - Idempotency stores the request hash only (already the case); the replayed response has no image.
- **Views** (`views.ts`): credential and proof views gain `biometric: null | { required: true, status, attemptsRemaining, matchScore, livenessScore, decidedAt, reason }`. A proof's `verified`/`disclosed` stay `null` until the gate passes; `outbox-consumer.ts` does not enrich a gated proof before the gate is `passed`.
- **Log routes:** `GET /v1/credentials/:id/biometric-log` and `GET /v1/proofs/:id/biometric-log` → `{ gate, events[] }`. Tenant scope (API key and console), `config.auditRead: true`.
- **Webhooks:** add `biometric.check_completed` to `EVENT_TYPES`. Body: the gate view plus `recordType`, `recordId`, `threadId`. It fires on every attempt decision and on expiry.
- **Wallet routes** (`http/routes/wallets.ts`, wallet-token scope):
  - `GET /v1/wallet/biometric-requirements?threadId=…` (up to 20): the requirement or nothing per thread, and 404-equivalent (omitted) for another tenant's thread.
  - `POST /v1/wallet/biometric-sessions {threadId, captureModules: [{provider, version}]}`:
    - checks that the wallet's tenant matches the gate's tenant and that the gate is pending;
    - 409 `capture_module_missing` if the provider's `captureModule` is not offered;
    - stores `capture_modules` on the wallet;
    - proxies `POST /checks/:id/sessions`, writes `session_started`, and returns `{ sessionId, provider, clientConfig, attempt, attemptsRemaining }`.
  - `POST /v1/wallet/biometric-sessions/:id/complete {clientOutput}`: proxies, updates the gate, writes `attempt_completed` (+ `declined` when attempts run out), enqueues the webhook, and calls `advanceGate()`. Returns `{ outcome: 'passed'|'failed'|'locked', attemptsRemaining }`, never scores.
  - Per-wallet rate limit on these routes (the first per-wallet limit; M4 is the general fix).
- **Gate engine** (`src/biometric/gate.ts`): `advanceGate(gateId)`, single-flight per gate and compare-and-set on every status move (trap 38):
  - hold reached (`request-received` / `presentation-received` seen by `applyRow`) **and** passed → agent `issue`/`accept` → event `issued`/`accepted`;
  - `failed` or `expired` → agent `decline` (whatever the exchange state, including `offer-sent`) → event `declined`/`expired`;
  - hold reached **but** pending → event `hold_reached`, and wait.
  - Triggers: `outbox-consumer.ts` `applyRow` for gated rows, the complete route, and an expiry loop every 30 s in `main.ts` (drained on SIGTERM like the others).
- **Console-scope routes** (tagged `console-only`, audited):
  - `GET/PUT /v1/biometrics/settings`;
  - `GET /v1/biometrics/providers`;
  - `GET/PUT/DELETE /v1/biometrics/provider` (write-only secrets, proxied);
  - `POST /v1/biometrics/provider/test`;
  - `GET/PUT /v1/credential-definitions/:id/biometric-policy`;
  - proof-template CRUD accepts `biometricPolicy`;
  - `GET /v1/biometrics/adoption` (wallet counts per reported capture module).
- **Client and config:** `src/biometric-client.ts` (modeled on `agent-client.ts`, 30 s timeout, 4xx passthrough). Config adds `BIOMETRIC_SERVICE_URL`, `BIOMETRIC_INTERNAL_TOKEN` and `BIOMETRIC_ENABLED`. With it false, every biometric route answers 404 and the gate never applies, so self-hosters can run without the service.
- **OpenAPI and docs:** `npm run openapi` (both files); `docs/api.md` gains a "Biometric checks" section (policy, reference image rules, flow, webhook, log).

### B4 — Android SDK
Add-ons are platform-specific. Naming mirrors the core:

| | Core (existing) | AWS add-on (new) | Mock add-on (new) |
|---|---|---|---|
| Gradle module | `:sdk` | `:biometrics-aws` | `:biometrics-mock` |
| Maven coordinate | `com.12id:holder-sdk-android` | `com.12id:holder-sdk-android-biometrics-aws` | `com.12id:holder-sdk-android-biometrics-mock` |
| Kotlin package | `com.onetwoid.sdk` | `com.onetwoid.sdk.biometrics.aws` | `com.onetwoid.sdk.biometrics.mock` |
| Entry class | `OneTwoId` | `AwsFaceLivenessCapture` | `MockFaceCapture` |

- **Core `sdk`** (no vendor dependency):
  - Public API:
    ```kotlin
    interface BiometricCapture {
      val provider: String            // matches the server adapter's captureModule.provider
      val version: Int
      suspend fun capture(activity: ComponentActivity, session: CaptureSession): CaptureOutput
    }
    fun OneTwoId.registerCapture(capture: BiometricCapture)
    suspend fun OneTwoId.verifyFace(activity: ComponentActivity, exchangeId: String): BiometricOutcome  // Passed | Failed(attemptsRemaining) | Locked
    ```
    `CaptureSession` and `CaptureOutput` carry opaque JSON (`clientConfig` / `clientOutput`), so the core never learns vendor types.
  - Models: `CredentialOffer.biometric` and `ProofRequest.biometric: BiometricRequirement?` (`attemptsRemaining`, `provider`). They are filled on `OfferReceived` / `ProofRequested` (and in `pendingOffers()` / `pendingProofRequests()`) through `GET /v1/wallet/biometric-requirements` by thread id.
  - `acceptOffer` / `respondToProofRequest` throw `BiometricRequired` while a requirement is open and not passed. This is a UX guard; the server enforces regardless.
  - Exceptions: `BiometricRequired`, `BiometricFailed(attemptsRemaining)`, `BiometricCaptureUnavailable(provider)`, `BiometricCancelled`.
  - `PlatformClient`: the three wallet routes, with the same 401 → token refresh once.
  - `apiDump` updated; the `org.hyperledger` scan test is extended to vendor packages (`com.amplifyframework`, `aws.sdk`).
- **`:biometrics-aws`:**
  - Wraps Amplify UI Face Liveness in an internal `ComponentActivity` started for result. It feeds `clientConfig` credentials through a static credentials provider and returns `{}` as `clientOutput` (AWS holds the result).
  - Consumer R8 rules; `minSdk` per B0.
- **`:biometrics-mock`:** a screen with "live / not live" and "same face / other face" buttons, used by the sample and the smoke over adb.
- **Sample app:**
  - registers both add-ons (mock in debug only);
  - a "Verify face" step on gated offers and proof requests;
  - a debug intent `verifyFace <exchangeId>` for smoke driving.
- **Docs:** `docs/integration.md` gains "Biometric checks": the Gradle line, `registerCapture`, the flow, error handling, camera permission, and the vendor-switch procedure (ship the new add-on → watch adoption in the console → switch).
- **iOS:** not this phase. Phase 5-iOS mirrors it as a separate Swift package product next to the core (e.g. `OneTwoIdBiometricsAws`).

### B5 — Console
- **Exchanges (audit):** in `ExchangeTables` (`features/tenant-data/panels.tsx`, shared by tenant and operator pages):
  - a **Biometric** column on the credential and proof tables, with a status badge (`—`, `pending`, `passed`, `failed`, `expired`) and the match score;
  - a row action **Biometric log**: a dialog (pattern: `DeliveriesPanel` body view) listing the gate events in order, with time, type, attempt, provider, liveness and match score against thresholds, decision, reason and AWS session id. No images.
  - Server functions in `features/portal/portal-data.functions.ts` and `features/tenant-data/tenant-data.functions.ts`.
- **Tenant settings:** `routes/_authed/t/$orgSlug/biometrics.tsx` (pattern: `webhooks.tsx`), owner/admin via `tenantCan(role, { biometrics: ['update'] })`. It has:
  - an enable switch;
  - the provider form generated from `configSchema`. AWS shows region and role ARN, plus our external id and a copyable trust-policy / permissions-policy snippet;
  - a **Test connection** button;
  - the default policy form.

  Secrets are write-only: the form shows "configured" and never reads a value back.
- **Policies:**
  - a **Biometric** action per credential definition in `catalogue.tsx` (a policy dialog);
  - a policy section in `features/portal/template-builder.tsx` + `lib/template-schema.ts` (`biometricPolicy`).
- **Operator:** `routes/_authed/ops/tenants/$tenantId/biometrics.tsx`, read-only, with a nav entry.
- `npm run openapi:client`; permissions added to `lib/permissions.ts`; every form uses the existing `useHydrated()` gating (traps 32, 36).

### B6 — Infra
- **`infra/staging/compose.biometric.yml`:**
  - `biometric-provision` (creates the `biometric` database on `agent-postgres`, runs migrations) and `biometric-service`.
  - Networks: a new `12id-biometric` (shared with platform-api only) plus the agent network for Postgres.
  - `mem_limit`, and a health check.
- **Secrets:** `secrets/biometric.sops.env` holds `BIOMETRIC_MASTER_KEY`, `BIOMETRIC_INTERNAL_TOKEN`, `BIOMETRIC_AWS_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`, plus the token in `platform.sops.env`. Commit the VM's files before any sync (trap 45).
- **Backups:** add `biometric` to the agent-postgres loop in `infra/scripts/backup-postgres.sh`, and to the restore drill in `infra/runbooks/backup-restore.md`. A restore also needs `BIOMETRIC_MASTER_KEY`.
- **Edge:** nothing new is public (the SDK reaches platform-api only).
- **Runbook:** `infra/runbooks/biometric-service.md`, covering:
  - deploy;
  - tenant AWS setup (role, trust policy with our principal and the external id, permissions `rekognition:CreateFaceLivenessSession`, `GetFaceLivenessSessionResults`, `StartFaceLivenessSession`, `CompareFaces`);
  - master-key rotation (re-wrap the DEKs);
  - restore.
- **Monitoring:** a blackbox probe of `/healthz` and an alert on the failed-check rate.

### T — Tests
- **biometric-service** (`node --test`, test Postgres):
  - encryption round-trip, and a wrong tenant/AAD failing;
  - the decision table (live/liveness/match thresholds, attempts, lockout);
  - image wipe at decision and expiry;
  - session single-use;
  - the mock adapter;
  - the AWS adapter against a stubbed client (request shapes, no `OutputConfig`, session policy);
  - GET provider never returns secrets.
- **agent-service:** per-record `Never` parks at `request-received` / `presentation-received`; issue/accept/decline routes; reconcile abandons held records.
- **platform-api** (`fakeAgent()` extended with issue/accept/decline, plus a `fakeBiometric()`):
  - policy resolution;
  - 422/409 cases;
  - `advanceGate` with hold-before-pass and pass-before-hold;
  - fail/expiry → decline;
  - one event per transition;
  - wrong-tenant wallet → omitted/404;
  - `capture_module_missing`;
  - a gated proof never stores `disclosed` on fail;
  - no image in `webhook_deliveries.body`, `idempotency_keys` or `exchange_gate_events`;
  - `BIOMETRIC_ENABLED=false` → routes 404.
- **SDK (JVM):** requirement mapping, the `BiometricRequired` guard, capture-module dispatch, and the exceptions; the API surface scan.
- **`smoke:biometric-credo`** (`infra/smoke/biometric-credo.ts`, staging, mock provider, Credo holder driving the wallet routes directly with a wallet token):
  1. Tenant enables biometrics with the mock provider, and the cred def policy is `required`.
  2. Offer with a reference → holder passes → accepts → **issued**, with events `gate_created → session_started → attempt_completed(passed) → hold_reached? → issued`.
  3. Offer → holder accepts **without** a check → the credential is **not** issued → TTL → `expired` → abandoned + webhook.
  4. Offer → 3 failed matches → `locked` → declined → abandoned.
  5. Gated template proof → the holder presents before passing → `verified`/`disclosed` null → pass → accepted → released. A second one fails → never stored.
  6. `biometric-log` returns the expected sequence for every case; webhook signatures verify.
- **`smoke:sdk-biometric-android`** (`infra/smoke/sdk-biometric-android.ts`, phone, AWS provider in the owner's account):
  - a live face against a matching reference → issued;
  - a mismatched reference → failed;
  - a printed photo → failed (record Confidence);
  - a proof gate with a live face → released;
  - each attempt visible in the console log.
- **Grep check** (after both smokes): search every store (platform DB, `biometric` DB after the decisions, agent outbox, container logs) for the reference image's sha256 and a 64-byte base64 prefix. Run the backup script, restore the `biometric` dump into a scratch Postgres, and confirm `checks` holds only ciphertext or `NULL`.
- **Console Playwright** (local + staging specs):
  - configure mock and test it;
  - set the template policy;
  - run an exchange through the API;
  - see the Biometric badge and log dialog on the tenant and operator exchanges pages;
  - a member cannot edit settings.

## Order
B0 spike → B1 (mock adapter first) → B2 → B3 → `smoke:biometric-credo` (mock) → B5 console → B1 AWS adapter + B4 SDK + add-ons → `smoke:sdk-biometric-android` on the phone → B6 runbook, monitoring → docs.

## Verification (gate)
- Unit suites green: `services/biometric-service`, `agent-service`, `platform-api`, `sdk-android :sdk:test :sdk:apiCheck`, console unit + Playwright.
- **`smoke:biometric-credo` PASSED** on staging (steps 1–6).
- **`smoke:sdk-biometric-android` PASSED** on the Xiaomi with the AWS add-on.
- The grep check finds no image outside biometric-service's encrypted, short-lived rows. The backup restore shows ciphertext or `NULL` only.
- Findings recorded in `16-phase-6-biometric-findings.md` in the 4-init §0.1 tier vocabulary.

## Document updates
- `15-phase-6-biometric.md` (this plan) and `16-phase-6-biometric-findings.md`.
- `15-phase-6.md` → **`17-phase-7.md`** (numbered after this plan and its findings, `16-phase-6-biometric-findings.md`): title and §10 renamed to Phase 7, §11 notes the renumbering, and Appendix A runs after Phase 7. H1's fix must also cover `exchange_gates`, `exchange_gate_events` and biometric-service `checks`/`sessions`/`results`. H3 gains the `biometric` database.
- **4-init:**
  - header and §0.1;
  - §2.6, plus a new §2.8 Biometric service;
  - §3 rows;
  - §4 flows (a new §4.9 Biometric gate);
  - §5 stores;
  - §6 security;
  - §10 (Phase 6 new, Phase 7 review, Phase 8 hardening);
  - §12.17 decision;
  - traps from the findings.
- Memory: the pre-production-review note (renamed, Phase 7) and a Phase 6 note.

## Out of scope
- FaceTec and in-house providers (ports ready); iOS add-on (Phase 5-iOS); enrolled/stored reference images;
- 12id-managed vendor accounts; hosted web capture;
- retention/deletion of the biometric log (Phase 7, H1); a scoped DB role or dedicated instance (H3). *The scoped role was done by H3 on 2026-09-22; the dedicated instance was declined by the owner;*
- the stronger wallet ↔ connection binding through mediator routing keys;
- credential-embedded photos.
