# Phase 6 — Biometric gate: findings

**Plan:** [15-phase-6-biometric.md](15-phase-6-biometric.md). **Status (2026-09-21): built and deployed on staging.** The gate is proven end to end with the `mock` provider:
- `smoke:biometric-credo` **PASSED 18/18** (Credo holder over the public API);
- `smoke:sdk-biometric-android` **PASSED 12/12** on the Xiaomi (SDK + mock add-on).

The grep check and the backup/restore drill are clean. **With real AWS** (after the owner created the tenant role): the Face Liveness capture ran on the phone through the add-on; the same face matched at 99.9 and the credential was issued; a different face scored 2.7 and was refused ("AWS run" below). **Open:** photo/replay attack tests, the AWS capture in a release build, the console Playwright spec, a probe/alert, and a von-network restart policy.

Tier vocabulary as in 4-init §0.1: *run* = observed, *source read* = read in code or binaries, not exercised.

| Item | Result |
|---|---|
| B0 spike | **Done**, except attack tests: role and external id, session without S3, streaming-only device credentials, on-device capture, `CompareFaces` calibration (see "AWS run") |
| B1 biometric-service | Built; 30/30 tests; deployed (`12id/services:phase6`) |
| B2 agent-service hold points | Built; 48/48 tests; deployed |
| B3 platform-api gate | Built; 58/58 tests; migration `0004_biometric_gate`; deployed |
| B4 Android SDK + add-ons | Built; SDK JVM 39/39 + `apiCheck`; `:biometrics-aws`, `:biometrics-mock`; sample |
| B5 console | Built; `tsc`, Vitest 22/22, client-bundle check; deployed (`12id/console:phase6`). Playwright `e2e/biometrics.spec.ts` **passes locally** (see "Console Playwright") |
| B6 infra | `compose.biometric.yml`, `biometric.sops.env`, backups, runbook `infra/runbooks/biometric-service.md`, monitoring (probe + 5 alerts, see F12) |
| `smoke:biometric-credo` (mock, staging) | **PASSED 18/18** |
| `smoke:sdk-biometric-android` (mock, phone) | **PASSED 12/12** |
| `smoke:sdk-biometric-android` (aws, phone) | **Run:** real pass (match 99.9) and real mismatch refused (match 2.7); script 7/10 because the attempts were done out of order (see "AWS run") |
| Grep check | **Clean** |
| Backup + restore of `biometric` | **Clean** |

## B0 spike (partial)

Server side, from a workstation with the owner's IAM user (`arn:aws:iam::329166137306:user/nazihar`), `ap-south-1` (*run*):
- `CreateFaceLivenessSession` with `Settings.AuditImagesLimit: 0` and **no `OutputConfig`** succeeds. `GetFaceLivenessSessionResults` on a fresh session answers `CREATED`.
- `CompareFaces` is authorised (rejected only the dummy bytes: `InvalidImageFormatException`).
- The user has **no IAM permissions** (`iam:GetRole` denied), so the spike could not create the tenant-style role itself. It also has **no `sts:GetFederationToken`**.

Consequence: short-lived, streaming-only device credentials need a role. That matches the design, where tenants bring a role and we pass an external id. The owner has the trust and permissions policies (the console's "AWS setup" panel shows the same). Role ARN `arn:aws:iam::329166137306:role/12id-biometric-spike-tenant`; the external id is in the git-ignored `services/spikes/.b0-state.local.json`.

Device side (*source read*, compiled; not run against AWS yet):
- Amplify UI Liveness **1.11.0** declares `minSdkVersion 24`.
- Its `FaceLivenessDetector(sessionId, region, credentialsProvider: AWSCredentialsProvider?, disableStartView, onComplete, onError)` takes an injected credentials provider, so no Cognito and no `amplifyconfiguration.json` are needed. The add-on feeds it `AWSTemporaryCredentials` built from the platform's `clientConfig`.
- The add-on hosts it in its own non-exported Activity, so host apps need no Compose.

**Still to run with the role:**
- the session and device-credential test (`services/spikes/src/b0-aws-liveness.ts session`, which also checks that the device credentials cannot call Create/GetResults);
- a real capture on the phone;
- `GetFaceLivenessSessionResults` returning ReferenceImage bytes without S3;
- `CompareFaces` scores for same person versus other person (to calibrate the default 90);
- photo and screen replay attempts.

## AWS run (2026-09-21, after the owner created the role)

**Server side** (`b0-aws-liveness.ts session`, *run*):
- AssumeRole works only with the right external id: missing or wrong is refused.
- `CreateFaceLivenessSession` works with no S3 output.
- The vended device credentials are refused for `CreateFaceLivenessSession` and `GetFaceLivenessSessionResults`: they can only stream.
- The platform's connection test passed from staging, with the tenant's own external id added to the role's trust policy, exactly as a tenant would do from the console.

**On the phone** (`smoke:sdk-biometric-android PROVIDER=aws`, Xiaomi, Android 14, debug build, 09:55–09:57 Z, *run*): the Amplify Face Liveness screen ran from the add-on with the injected credentials (no Cognito); video streamed from the phone; the result was fetched server-side; the tenant's reference (a PNG) was compared with `CompareFaces`.

| Attempt | Who (as it happened) | Liveness | Match | Decision |
|---|---|---|---|---|
| credential 1 | the reference person | 99.57 | 99.95 | passed → credential issued |
| credential 2 | the reference person (the script asked for someone else) | 99.85 | 99.98 | passed |
| proof | a different person (the script asked for the reference person) | 99.10 | **2.66** | failed `match_below_threshold`, 2 attempts left |

The script reported 7/10 only because the people at the phone swapped the second and third attempts. **Every decision was correct: same face ≈ 99.9, different face ≈ 2.7**, so the default `minMatchScore` of 90 has a wide margin. The unanswered proof stays pending and expires.

**Photo attack and R8 (2026-09-21 10:13–10:15 Z, *run*, `smoke:sdk-biometric-android PROVIDER=aws ATTACK=1` PASSED 12/12).** The sample was built with `-PminifyDebug`: R8 and resource shrinking as in release, with the adb hooks kept. The AWS add-on and Amplify survived shrinking (the capture activity is kept by its consumer rule).

| Attempt | Liveness | Match | Decision |
|---|---|---|---|
| real face, reference person | pass | pass | passed → credential issued |
| **photo of the reference person held up to the camera** | **0.13** | 99.99 | refused `liveness_below_threshold` |
| real face, reference person (proof) | **93.2** | 99.97 | passed → proof released |

The photo matched the face perfectly but failed liveness by a wide margin, so the gate rejected it. **Watch:** one genuine attempt scored 93.2 on liveness, close to the default minimum of 90 (the others scored 99+). Collect more genuine scores before raising the default, and consider 80–85 if genuine users get refused.

**Still not run:** a screen-replay (video) attack.

## Console Playwright (2026-09-21)

`e2e/biometrics.spec.ts` passed locally (run together with `auth.spec.ts`, which enrols the run's operator):
- an owner configures the mock provider, runs the connection test, switches the gate on and sets a minimum match of 92 (kept after a reload);
- the owner sets a template to "always", and the list shows `required`;
- on a seeded gated exchange, the Biometric column shows `passed` / `match 99.0`, and the log dialog shows every step with scores against the thresholds and the vendor session ids;
- the operator sees the settings read-only and the same log.

Recipe:
- biometric-service on 3530 (`BIOMETRIC_ENABLE_MOCK=true`, database `biometric_e2e`);
- platform-api on 3510 per the Phase 4 local recipe plus `BIOMETRIC_SERVICE_URL=http://127.0.0.1:3530` and a 40-character `BIOMETRIC_SERVICE_TOKEN` equal to the service's `INTERNAL_TOKEN`; run both provision steps first;
- then `E2E_PLATFORM_API_URL=http://127.0.0.1:3510 npx playwright test e2e/auth.spec.ts e2e/biometrics.spec.ts`.

No staging spec yet: the staging tenants would need biometrics switched on.

## Findings

**F1 · SDK · The wallet token provider was called on every platform request (*run*, fixed).**
- **What happened.** Phase 5's `PlatformClient` asked the host app's `walletTokenProvider` for a token on each call. That was harmless while the SDK called the platform only at onboarding. Phase 6 adds a call per `pendingOffers()` / `pendingProofRequests()`.
- **Why it broke.** The sample's provider (like a typical customer's) asks its backend, and a retried `POST /v1/wallets` **rotates** the token. Concurrent calls therefore invalidated each other: a 401 on the phone, and `SocketTimeoutException`s from piled-up backend round trips. Requirements came back empty, and the client-side guard let `acceptOffer` through. The server still held the credential, which is exactly what the server-side enforcement is for.
- **Fix.** The token is cached per process behind a mutex and refreshed only after a 401, by exactly one caller. Unit test added.
- **Lesson.** Anything the SDK calls often must not reach the customer backend.

**F2 · Sample · A new debug action needs its manifest entry (*run*, fixed).** `VERIFY_FACES` was handled in `DebugReceiver`, but the debug manifest lists every action explicitly. The broadcast was silently dropped: `Broadcast completed: result=0`, and the receiver logged nothing.

**F3 · Android · Amplify requires core library desugaring in the host app (*run*).**
- `checkDebugAarMetadata` fails without it (Amplify core, aws-core, aws-predictions, common-core).
- Amplify also puts `listenablefuture:9999.0-empty-to-avoid-conflict-with-guava` on the app's compile classpath while Guava itself is only on the runtime classpath. That hides CameraX's `ListenableFuture` in the sample's QR scanner. Declaring `guava:33.3.1-android` (already at runtime) fixes it.
- Both are in the integration guide.

**F4 · Android · Size (*run*).**

| Build | Phase 5 | Phase 6 (AWS add-on; mock in debug only) |
|---|---|---|
| Sample, arm64, debug | 42.7 MB | 58.1 MB |
| Sample, arm64, minified release | 28.7 MB | **37.0 MB (+8.3 MB)** |

The minified release onboards on the phone (`state=Ready`). R8 prints one warning about a pre-shrunk androidx navigation class from a transitive dependency; it is harmless: the AWS capture ran in a shrunk build (see "Photo attack and R8").

**F5 · Staging · The ledger did not come back after a VM reboot (*run*, restored).**
- The VM rebooted on 2026-09-20 08:09, probably a kernel update from unattended-upgrades. The von-network containers have restart policy `no` and stayed `Exited (137)` for 25 hours.
- Nothing alerted: the ledger write probe's metric and alerting do not reach anyone while alert e-mail is unconfigured, and Alertmanager is in a restart loop.
- Restored with `./manage start 123.176.58.72` (not `down`, so data and genesis were unchanged); the write probe committed a NYM in 0.3 s afterwards.
- **Done (2026-09-21):** `infra/staging/systemd/12id-von-network.service` (enabled; runs `./manage start 123.176.58.72` at boot) plus `restart: unless-stopped` on the five von containers (`docker update`). Not proven by a reboot, to avoid disrupting staging. Alert delivery (review M16) is still open; Alertmanager is still in a restart loop.

**F6 · Trap 44 recurs under load (*run*).**
- `POST /v1/credential-definitions` answered 502 `agent_unreachable` twice in a row, while the VM's load average was about 6 on 4 vCPUs.
- Both definitions were published anyway. The smoke now accepts `CRED_DEF_ID` to reuse one.
- Fix remains review M5 (Phase 7).

**F7 · Credo holder logs an error on the issuer's `issuance-abandoned` problem report (*run*).** When the gate abandons an exchange, the Credo 0.7 holder logs "Error handling message … problem-report" but still ends in `abandoned`. The Kotlin holder is not tested for this yet.

**F8 · Setup must run on the VM (by design).**
- Biometric settings are console-only, and the edge refuses console headers.
- `infra/smoke/biometric-setup.sh` therefore runs `node` inside the platform container, where `CONSOLE_TOKEN` already lives. The first version sent `content-type: undefined` on bodiless calls (415); fixed.

**F9 · Clocks (*run*, fixed in B1).** biometric-service's expiry compared rows against Postgres `now()` while the rest used the Node clock. On Docker Desktop the container clock drifts, and a check that was due was not expired. Everything now uses one clock (the service's).

**F10 · Transactions and expiry (*run*, fixed in B1).** Expiring a check inside `startSession`'s transaction and then throwing rolled the expiry back, so the image was not wiped. The expiry is now written before the transaction.

**F11 · A template edit must not clear its policy (*run*, fixed in B3).** The console's builder sends the definition without `biometricPolicy`, and a PUT would have cleared it. An absent field now leaves the policy unchanged, and a dedicated `PUT /v1/proof-templates/{id}/biometric-policy` changes it (regression test added).

## As built (differences from the plan)

- **agent-service** routes are `…/credentials/:id/issue`, `…/credentials/:id/abandon`, `…/proofs/:id/accept` and `…/proofs/:id/abandon` (the plan said `decline`). Abandon sends a best-effort problem report, then abandons locally with an outbox row, like the reconciler.
- **platform-api** adds `GET/PUT /v1/proof-templates/{id}/biometric-policy` (F11). Gate statuses include `cancelled` (the holder declined, or the exchange closed).
- The biometric log is `exchange_gate_events`, with a `session_id`; `exchange_gates.settled_at` marks that the agent has been told.
- **Wallet binding** is the same-tenant wallet token plus the DIDComm thread id, as planned. The routing-key binding was not built.
- **The mock provider** is on in staging (`BIOMETRIC_ENABLE_MOCK=true`); the AWS provider is offered because 12id's principal keys are in `biometric.sops.env`. For now these are the owner's IAM user keys, which the owner will rotate.

**F12 · Monitoring (2026-09-21, *run*).**
- **Probe.** biometric-service `/healthz` is published on 127.0.0.1:3430 and probed by a new plain-HTTP blackbox module `http_2xx_local` (job `blackbox-http-local`). The public `http_2xx` module requires TLS, and the first attempt failed on exactly that.
- **Exporter.** A new `postgres-exporter-biometric` (127.0.0.1:9189) reads platform-api's biometric log: `biometric_attempts_last_15m{decision}`, `biometric_vendor_failures_last_15m`, `biometric_gates_unsettled`, `biometric_gates_overdue_pending`.
  > **Phase 7 update (2026-09-23, review M16):** this exporter also reports platform-api's webhook deliveries, wallet counts and idempotency table size, next to two new exporters for `agent_service` (outbox lag) and `endorser_service` (refusals). A changed query file needs `--force-recreate`: the single-file mount keeps a stale inode (trap 50).
  >
  > **Phase 7 update (2026-09-22, review H3):**
  > - This exporter and the two others connect as `monitoring_ro` (`pg_monitor` plus read-only access), no longer as `postgres`. Scrape errors stayed at 0.
  > - biometric-service itself connects as the `biometric` role, owner of the `biometric` database only.
  > - See [`17-phase-7.md`](17-phase-7.md) H3.
- **Alerts:** `BiometricServiceDown`, `BiometricFailureRateHigh`, `BiometricVendorErrors`, `BiometricGateStuck`, `BiometricExpiryStalled`. Validated with promtool (19 rules); all inactive against live data.

Found on the way, all pre-existing:
- **Alertmanager** had been restarting forever: the image runs as `nobody` and the `/run/smtp` tmpfs was root-owned. Fixed with `uid=65534,gid=65534,mode=0700`.
- **indy-vdr-proxy** answered 502 for 26 h: it started before the ledger after the reboot and never retries its pool connection. Restarted, and the ledger boot unit now restarts it after the validators.
- **cAdvisor** sat at its 256 MiB cap: scrapes timed out (up about 7% of 12 h) and it used about 40% CPU. Raised to 512 MiB; the VM load fell from about 5.8 to about 2.

**Email delivery works (2026-09-21):** the owner added `GMAIL_APP_PASSWORD` with the new `infra/scripts/set-secret.sh`, which prompts for the value hidden and needs no editor. A test alert was sent to onetwoidadmin@gmail.com: `alertmanager_notifications_total{integration="email"} 1`, 0 failed.

## Evidence

- `smoke:biometric-credo`, 2026-09-21 09:15 Z, tenant "Biometric Smoke 2026-09-21" (`a249dc92-…`), mock provider:
  - 422 without an image;
  - pass before hold → `gate_created>session_started>attempt_completed>hold_reached>issued`;
  - hold before pass: not issued after 15 s, then `…hold_reached>session_started>attempt_completed>issued`;
  - lockout `failed,failed,locked` → `declined`, exchange `abandoned`;
  - gated proof: `presentation-received` with `verified=null`, then pass → `accepted` → `verified=true` + disclosed;
  - 6 `biometric.check_completed` webhooks, no image in any webhook, all signatures valid.
- `smoke:sdk-biometric-android`, 2026-09-21 09:31 Z, Xiaomi 2109119DI, Android 14:
  - fresh install Ready; connect;
  - the offer shows `Pending/3/mock`;
  - `acceptOffer` → `BiometricRequired`;
  - `verifyFace` Passed → credential done;
  - second offer Failed (`attemptsRemaining=2`), platform still `offer-sent`/pending;
  - gated proof Passed → released (`phone-pass`);
  - log entry liveness 97, match 99, vendor session `mock-…`.
- **Grep check** on staging, after the smoke. The reference image's base64 prefix appears in 0 rows of `webhook_deliveries`, `idempotency_keys`, `exchange_gate_events`, `exchange_gates`, `credentials`, `proofs` and `agent_service.outbox`, and in 0 lines of the platform-api, biometric-service and agent-service logs. `biometric.checks`: 12 rows (passed 9, failed 3), **0 with an image**.
- **Backup** `20260921T091641Z` includes `agent-biometric.dump.age` (15 KB). Restored into a scratch Postgres: 12 checks, 0 with an image, 1 provider config (ciphertext).

---

## Conditional gate on proof templates (2026-10-11)

**Plan:** [15-phase-6-biometric.md](15-phase-6-biometric.md) "Conditional gate on proof templates". **Status: built and tested locally. Not deployed to staging; `smoke:biometric-credo` step 5 is written and has not run** (a staging deploy needs a release candidate and the owner's go-ahead).

| Item | Result |
|---|---|
| platform-api | `tsc` clean; **111/111** tests against the local Postgres; migration `0011_biometric_condition` generated and applied to the test and e2e databases |
| console | `tsc` clean; Vitest **44/44** (new `test/face-check-rule.test.ts`); Playwright local **6/6**, with `biometrics.spec.ts` extended |
| reference backend | `tsc` clean; **17/17** tests |
| `smoke:biometric-credo` step 5 (staging) | **not run** |
| Phone | **not run** |

### Evidence (*run*, local)
- **Rule evaluation** (`test/biometric-policy.test.ts`): each operator at, below and above the value; `any` and `all`; the same parameter twice as a range; 1/0 for a yes/no fact; a missing parameter refused even when another condition already holds; 0 and 6 conditions, an unknown operator, a bad name and an infinite value refused; a credential definition cannot take the mode.
- **Through the API** (`test/biometric.test.ts`, real Postgres, agent and biometric-service doubled):
  - a missing parameter answers 422 and no proof request reaches the agent;
  - 3000 / 20 → 202 with no gate row, no hold, `required: false`; the proof then completes and is released;
  - 7200 / 20 and 3000 / 85 → gate created, held, check created with the template's threshold (match 95) and the tenant's default (liveness 85);
  - rule true without an image → 422 `biometric_reference_required`;
  - the numbers sent are in the log route and in no webhook body;
  - a later change of the rule leaves an earlier outcome as it was;
  - a template edit without `biometricPolicy` keeps the rule (the F11 case);
  - `params` are ignored on `off` and on an inline request; with the tenant's biometrics off nothing is evaluated.
- **Erasure and masking** (`test/data-protection.test.ts`): erasure on request and the retention job set the inputs to null and keep the rule and the decision; a proof without a rule stays without one; an operator sees the inputs as null, and sees them after a reveal with a reason.
- **Console in a browser** (`e2e/biometrics.spec.ts`): an owner sets "any of: amount ≥ 5000, riskScore > 70" on a template; the list shows `when amount ≥ 5000 or riskScore > 70`; the dialog reopens with the rule filled in; a seeded proof the rule decided against shows "not required", and its log shows `amount ≥ 5000 · sent 3000 · not met`; the operator sees `sent hidden`.

### Findings

**F13 · Console · The local Playwright suite could not start since Phase 9 W2 (*run*, fixed).**
- **What happened.** The dev server answered 500 on every request: `MAIL_OUTBOX_FILE: cannot read test-results/mail.jsonl: ENOENT`.
- **Why.** W2 (review M11) reads every `NAME_FILE` variable as "a secret to load from this file" (`file-env.server.ts`). The e2e-only variable `MAIL_OUTBOX_FILE` matches that pattern. Had the file existed, its content would have been loaded into `MAIL_OUTBOX` and the outbox switched off.
- **Fix.** The variable is now `MAIL_OUTBOX_PATH` (console `env.server.ts`, `email.server.ts`, `e2e/env.ts`, `test/env.test.ts`). It is not used on staging or in production.
- **Consequence.** The local Playwright suite cannot have started between W2 and this fix; the staging specs were not affected.

**F14 · Console · Escape does not close a dialog while a combobox in it has focus (*run*, cause inferred, not fixed).** In the new spec step, Escape left the policy dialog open; the dialog opens with its combobox focused, which presumably takes the key. The spec now uses Cancel. It would apply to every form dialog that opens on a combobox. Low priority.

**F15 · Local e2e recipe (*run*).** The env files the recipe names (`%TEMP%/e2e-stack.env`, `e2e-bio.env`) were gone. They were rebuilt from `config.ts` of both services:
- platform-api on 3510 with `DATABASE_URL=…/platform_api_console`, `BIOMETRIC_SERVICE_URL=http://127.0.0.1:3530` and a 40-character `BIOMETRIC_SERVICE_TOKEN` equal to biometric-service's `INTERNAL_TOKEN`;
- biometric-service on 3530 with `BIOMETRIC_ENABLE_MOCK=true`, database `biometric_e2e`, and any 32-byte base64 `BIOMETRIC_MASTER_KEY`;
- run both `provision.ts` first. Postgres is the container `12id-p2-postgres` (55432).

### Still to do
- Release candidate → staging (platform-api with migration `0011`, console) → `smoke:biometric-credo` including step 5.
- On the phone with tenant MTB: set the `transaction` template to `amount ≥ 5000` and add `"faceCheckParams": ["amount"]` to the reference backend's `tenant.json`. A transfer of 1000 should be approved without the camera; one of 5000 should ask for the face check.
- Redeploy the reference backend on staging **before** setting a rule on its template: the code running there sends no `params`, so a conditional template would refuse every request.
