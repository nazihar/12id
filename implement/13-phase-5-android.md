# Phase 5 — Android Holder SDK (plan)

## Context
Phases 0–4 are done and on staging (`12id/implement/1…12`):
- ledger, patched mediator `-p2`, agent-service, platform-api with wallet tokens and per-wallet mediator invitations, `wallet.sync_requested` wake path, console.
- The native Kotlin holder has passed `smoke:android`, `smoke:tenant-android` and `smoke:platform-android` on the phone.
- It is still the **Phase 0 sample app** in `phase0/android/`: a fork clone at upstream `e1efb7a` with two uncommitted fixes, a hard-coded mediator invitation, a genesis URL, auto-accept everything, no key protection, and GitHub-Packages-only dependencies.

Phase 5 (4-init §10), **Android only**, turns that into a product: an embeddable SDK customers put in **their** apps, with no Aries concepts on its surface. It uses the platform endpoints Phase 3 built for it. iOS stays gated on the Swift pass. §12.6 already allows Android to start ahead of it.

**Outcome:** SDK + fork + sample app in `12id/sdk-android/`, built and consumed through a local Maven repo. Gate: `smoke:sdk-android` passes on the phone against staging.

## Decisions (this session)
| Item | Decision | Consequence |
|---|---|---|
| Scope | Android only | Swift pass, parity suite and iOS SDK stay open; the API is designed so iOS can mirror it |
| Wallet recovery (§12.2) | **Accept loss, re-issue** | No backup/export in v1. `reset()` + re-onboarding; documented for customers. Backup can be added later without breaking the API |
| Distribution | **Source / local Maven only for now** | `maven-publish` to a file repo inside the project; the sample consumes the SDK **only** through that repo, which proves the consumer path. Public repo chosen before the first customer (new §12.16) |
| Coordinates | Maven group **`com.12id`** (product domain 12id.com), Kotlin package **`com.onetwoid`** | Artifact `com.12id:holder-sdk-android`; entry point `com.onetwoid.sdk.OneTwoId` |
| Push token (`registerPushToken`) | **Dropped** (§12.12) | The wake path already works through the mediator connection's `out_of_band_id`; the SDK only exposes `sync()` |

## Facts this plan builds on (verified while planning)
- **Framework surface:**
  - `Agent(context, AgentConfig)`, `initialize()`, `shutdown()`, `reset()`.
  - `agent.oob.receiveInvitationFromUrl`.
  - `agent.credentials` (v1 `CredentialsCommand`: `acceptOffer`, `declineOffer`, `acceptCredential`).
  - `agent.proofs` (`getRequestedCredentialsForProofRequest`, `acceptRequest`, `declineRequest`).
  - `agent.eventBus` with `AgentEvents.{Connection,Credential,Proof,Mediation,ProblemReport}Event`.
- **`MediationRecipient.pickupMessages()` is public**, so `sync()` needs no fork change to trigger a pickup.
- **Polling:** it runs on a private `Timer` started only inside `initialize`; `close()` cancels it and nothing restarts it.
- **Transports (unchanged from Phases 0–3, confirmed on staging):**
  - The mediator advertises **`wss://` first, then `https://`** (`AGENT_ENDPOINTS`; the https entry exists only because the mediator refuses to start without one).
  - The holder uses the first service, so its connection handshake, mediation, `PickUpV1` polling and delivery of queued messages all run over **one persistent `wss://` socket**. With https first, the mediation grant is lost (§2.7.3, trap 19).
  - Issuers forward to the holder through the mediator over `wss://`.
  - The holder talks to the **issuer/verifier over `https://`** (`https://agent.<domain>`), and to platform-api (`/v1/ledger`, `/v1/wallet/mediator-invitation`) over `https://`.
  - The SDK does not choose any of this; the invitation's service order decides it. The SDK must not rewrite it.
- **`assertInvitationUrl()` deletes the mediation record when `mediatorConnectionsInvite` differs from the stored one.** So the SDK must persist the invitation it onboarded with and pass exactly that on every later launch. A fresh invitation per launch would re-mediate each time and break routing for existing connections.
- **A spent invitation surfaces only as `RuntimeException("Connection to the mediator timed out.")`** (Phase 3 trap 31).
- **The UniFFI wrappers are also GitHub-Packages-only** (`settings.gradle` needs a token for `aries-uniffi-wrappers`), not just the framework. The phase0 app additionally pins a conflicting `anoncreds_uniffi:0.1.1`.
- **Toolchain:** AGP 8.0.2, Kotlin 1.8, compileSdk 33, JDK 17. `logback-classic` is an `implementation` dependency of the library, which forces a logging backend on customers.
- **Size:** 7 ABIs = 165.8 MB; arm64 split = 51.7 MB; `abiFilters` has no effect.
- **platform-api for the SDK:**
  - `GET /v1/ledger` → `{ indyNamespace, genesis: { url, sha256, signatureUrl, signingPublicKey }, vdrProxyUrl }` (public).
  - `GET /v1/wallet/mediator-invitation` (wallet token; each call mints a new single-use invitation and replaces the old one).
  - `POST /v1/wallets` replays with a **new** token for the same installation id.

---

## Workstreams

### A0 — Repository, fork, toolchain (first; small spike)
- **Create `12id/sdk-android/`:**
  - Upstream `aries-framework-kotlin` at `e1efb7a`.
  - Commit the two Phase 0 fixes as separate commits, using the phase0 diffs: optional `OutOfBandInvitation.label`, DidDoc `@context` (4-init §2.7.4).
  - Modules: `ariesframework` (fork), `sdk` (new, public), `sample` (new app).
  - Drop the upstream sample `app`.
  - Record the fork base + our commits in `services/VERSIONS.md`.
- **Wrapper mirror:** `scripts/mirror-uniffi.sh` downloads `askar_uniffi 0.2.0-wrapper.1`, `anoncreds_uniffi 0.2.0-wrapper.1` and `indy_vdr_uniffi 0.2.1-wrapper.2` (AAR + POM) once, with the owner's token, into `third_party/m2/`. Git-ignored or LFS; the checksums are committed. Afterwards `settings.gradle` has **no GitHub Packages repository and no token**. Coordinates stay unchanged until a public repo is chosen.
- **Local publishing:** `./gradlew publishAllPublicationsToLocalRepository` writes `build/m2/`.
  - The fork is published as `com.12id:aries-framework-kotlin:<fork-version>`.
  - The SDK is published as `com.12id:holder-sdk-android`.
  - The SDK depends on the fork via **`implementation`**, not `api`, so Aries types never reach the customer's compile classpath.
- **SDK levels:**

  | Module | minSdk | compileSdk | targetSdk |
  |---|---|---|---|
  | `ariesframework` (fork) | 24 (Android 7.0, unchanged) | 36 | not set (libraries don't need one; the app's value applies) |
  | `sdk` | **24** | **36** | not set |
  | `sample` | 24 | 36 | **36** |

  - **minSdk 24** is the framework's and wrappers' floor, and everything the SDK uses exists there: Keystore AES-GCM (23+), WorkManager, ProcessLifecycleOwner. Raising it later is a breaking change for customers, so it starts at the lowest proven level.
  - **compileSdk/targetSdk 36:** Google Play's yearly target-API rule (confirm the exact 2026 deadline while doing A0). Customers' apps will target 35–36, and the sample should behave like them (e.g. background-start and exact-alarm limits that affect `sync()` from a push).
  - Proven on-device level so far: Android 14 (API 34). An API 24–26 emulator run of steps 1–3 of the smoke is added to T.
- **Toolchain spike:** try AGP 8.9+ (needed for compileSdk 36)/Kotlin 2.x on the fork (kotlinx-serialization plugin bump). If it builds and `CredentialsTest`/`ProofsTest` unit tests still pass, keep it. Otherwise fall back to compileSdk 35 with the newest AGP that builds, and record why.

### F — Fork changes (keep each one small, one commit, noted in findings)
1. *(done in phase0)* optional OOB `label`.
2. *(done in phase0)* DidDoc context (needed while the mediator is Credo 0.6).
3. **Restartable pickup:** `MediationRecipient.startPickup()` / `stopPickup()` (idempotent; the timer is recreated). The SDK pauses polling in the background and resumes in the foreground.
4. **Pickup completion signal:** `BatchHandler`/`processBatchMessage` emits `AgentEvents.PickupEvent(messageCount)` so `sync()` knows when the queue is empty. Adding to the sealed interface is internal to our fork.
5. **Logging:** `logback-classic` moves to `testImplementation`; the library ships `slf4j-api` only. The SDK offers an optional log sink (default: `android.util.Log` behind a level).
6. **Consumer ProGuard/R8 rules** (`consumer-rules.pro`) for kotlinx.serialization models and UniFFI/JNA. Verified by a minified sample release build.

Nothing else is changed unless a smoke run forces it. `indy-vdr-proxy` support (§12.9) stays unbuilt.

### S — SDK module `com.onetwoid.sdk` (the product)
**Public API (Kotlin-first, coroutines, no Aries types):**
```kotlin
object OneTwoId {
  suspend fun initialize(context: Context, config: OneTwoIdConfig)   // idempotent, mutex-guarded
  val state: StateFlow<WalletState>        // Uninitialized | Initializing | Ready | Failed(error)
  val events: SharedFlow<WalletEvent>      // + addListener(WalletListener) for non-flow callers
  suspend fun connect(invitationUrl: String): Connection
  suspend fun connections(): List<Connection>
  suspend fun credentials(): List<Credential>;  suspend fun credential(id: String): Credential?
  suspend fun pendingOffers(): List<CredentialOffer>
  suspend fun acceptOffer(id: String);  suspend fun declineOffer(id: String)
  suspend fun pendingProofRequests(): List<ProofRequest>
  suspend fun proofRequestOptions(id: String): ProofRequestOptions   // candidates per group
  suspend fun respondToProofRequest(id: String, selection: ProofSelection)
  suspend fun declineProofRequest(id: String)
  suspend fun sync(timeout: Duration = 20.seconds): SyncResult       // host calls from its push handler
  suspend fun reset()                                                 // §12.2: wipe wallet + SDK state
}
data class OneTwoIdConfig(val apiBaseUrl: String, val walletTokenProvider: suspend () -> String,
                          val label: String = "12id wallet", val logSink: LogSink? = null)
```
- **Models:** `Connection(id, label, state, createdAt)`, `Credential(id, connectionId, schemaName, schemaVersion, credentialDefinitionId, attributes: Map<String,String>, issuedAt, expiresAt: Instant?, isExpired)`, `CredentialOffer`, `ProofRequest(id, connectionId, name, groups)`, `ProofSelection(groupKey → credentialId)`. Errors are a sealed `OneTwoIdException`: `WalletTokenRejected` (401), `NetworkUnavailable`, `InvalidInvitation`, `MediatorUnavailable`, `LedgerUnavailable`, `NotFound`, `InvalidSelection`, `WalletKeyLost`.
- **Wallet key:**
  - Generated with `Agent.generateWalletKey()`.
  - Wrapped with a non-exportable Android Keystore AES-256-GCM key, without user-authentication binding, so a push-woken `sync()` works while the screen is locked.
  - The ciphertext lives in `noBackupFilesDir`, together with SDK state (installation of wallet id, persisted mediator invitation, genesis cache).
  - If the wallet exists but the key cannot be unwrapped (e.g. Auto Backup restored files onto a new device): throw `WalletKeyLost`; the host calls `reset()` → re-onboarding (accept loss). The integration guide tells customers to exclude SDK files from Auto Backup/device transfer (`dataExtractionRules`).
  - `KeyWrapper` is an interface so JVM tests can fake the Keystore.
- **Genesis (§4.3, trap 1):**
  - `GET /v1/ledger`, download `genesis.url`, **verify sha256**, then cache it as `genesis-<sha256>.txn`. `poolName` is derived from the sha, so a rotated genesis opens a new pool.
  - On later launches the ledger config is refreshed best-effort; if unreachable, the cached file is used.
  - Minisign signature: verify if it can be done with existing dependencies (Ed25519 via Askar, but minisign prehashes with BLAKE2b). Otherwise sha256 over TLS only, recorded as a finding.
- **Mediator onboarding + spent-invitation recovery (trap 31):**
  - **First init** (no persisted invitation): `walletTokenProvider()` → `GET /v1/wallet/mediator-invitation` → persist the URL → `AgentConfig(mediatorConnectionsInvite = it, mediatorPickupStrategy = PickUpV1)`.
  - **Later inits:** always the persisted URL (see `assertInvitationUrl` above).
  - **On "mediator timed out"** and the wallet holds **no customer connections**: fetch a new invitation once, persist it, retry.
  - **With existing connections:** no re-mediation, because routing keys would silently break. The SDK reports `MediatorUnavailable` and retries on the next `initialize`/`sync`.
  - A 401 on the token → call the provider again once (replays rotate tokens), then `WalletTokenRejected`.
- **Protocol pins:** `PickUpV1`, polling interval internal (10 s), `useLegacyDidSovPrefix = true`, `autoAcceptCredential = Never`, `autoAcceptProof = Never`, `preferredHandshakeProtocol = Connections`.
  - The SDK itself calls `acceptCredential` when an accepted offer's credential arrives, so the host only ever decides on offers.
  - Spike first: confirm `Never` still surfaces offers and does not stall `credential-received`; fall back to `ContentApproved` if needed.
  - v2 credential events from the fork (`CredentialEventV2`) are ignored.
- **Lifecycle:**
  - `ProcessLifecycleOwner`: foreground → `startPickup()` (F3); background → `stopPickup()`.
  - Public calls are serialized behind init (a mutex), and every agent call runs on `Dispatchers.IO`.
- **`sync()`:**
  - Works from a cold process started by a push: runs `initialize` if needed (config supplied at `Application.onCreate`).
  - Then `pickupMessages()` in a loop until a `PickupEvent(0)` (F4) or the timeout.
  - Returns counts of new offers/requests/credentials.
  - No Firebase dependency in the SDK.
- **Events:** credential/proof/connection record transitions are mapped to `WalletEvent.{OfferReceived, CredentialStored, ProofRequested, ProofSent, ConnectionCompleted, ExchangeFailed(problemReport)}`.
- **API guard:** Kotlin `binary-compatibility-validator` (`apiDump` committed), plus a unit test that fails if any public signature references `org.hyperledger`.

### P — Sample app `sample/` (also the smoke target)
- Jetpack Compose screens: onboarding status, scan/paste invitation (CameraX + ML Kit barcode), credentials list/detail (expiry shown), pending offers (accept/decline), proof requests (choose a credential per group, share/decline).
- **Customer-backend stand-in:** `12id/infra/smoke/sdk-sample-backend.ts` (workstation, API key, reached through the existing `smoke-issuer.<domain>` tunnel). It has `POST /wallet {installationId}` → `POST /v1/wallets` with `Idempotency-Key = installationId` and returns the token. The app never holds an API key.
- **Push demo:** a `FirebaseMessagingService` example in docs only. The sample gets a **debug-only** `BroadcastReceiver` (`com.onetwoid.sample.SIMULATE_PUSH`) that starts an expedited `WorkManager` job calling `OneTwoId.sync()`, the same code path a real push handler uses. It also has debug intents for `connect <url>`, `acceptOffer`, `respondProof`, `wipeWalletKeepState` (smoke driving over adb; excluded from release).
- Consumes the SDK **only from `build/m2`**. Release build: ABI splits (arm64-v8a + x86_64 for emulators) or an App Bundle; R8 on.

### T — Tests
- **JVM unit (`sdk`):** record→model mappers (incl. `expiresAt` parsing, proof candidate mapping), genesis cache/sha mismatch, invitation-retry decision table (first init / has connections / 401 refresh), key-wrapper failure → `WalletKeyLost`, event mapping, API-surface scan.
- **Fork:** existing unit tests still green; new tests for `startPickup`/`stopPickup` idempotency and `PickupEvent`.
- **`smoke:sdk-android` (`12id/infra/smoke/sdk-android.ts`, the gate)** extends `platform-android.ts` (adb + public API + signed webhooks):
  1. Fresh install (`pm clear`) → onboarding with a wallet token from the sample backend; **no invitation or genesis compiled in**; wallet reaches `Ready`.
  2. Connect via debug intent → `connection.state_changed completed`.
  3. Offer → appears in `pendingOffers` (not auto-accepted) → accept → server `done`. A second offer → decline → server abandoned/problem report.
  4. **Offline + wake:** force-stop → wait out the debounce → offer → `wallet.sync_requested` → `SIMULATE_PUSH` broadcast with the app **not in foreground** → `sync()` collects it → accept → `done`.
  5. Proof from a template → `proofRequestOptions` lists the credential → respond → `verified=true`; a second request → decline.
  6. **Restart:** kill + relaunch → no new mediator connection (platform `mediator_oob_id` unchanged; mediator `DidcommConnection` count for the wallet unchanged) and credentials still listed.
  7. **Spent invitation:** `wipeWalletKeepState` (wallet deleted, persisted used invitation kept, no connections) → init times out → new invitation fetched → `Ready`.
  8. Size report (APK per ABI / AAB) and a minified release build launch.
- **Min-SDK check:** steps 1–3 on an API 24 (or lowest bootable) x86_64 emulator, which confirms the minSdk 24 claim, the Keystore key wrap and UniFFI loading on old Android.

### D — Docs
- `sdk-android/docs/integration.md`: Gradle setup (local repo for now), `Application.onCreate` init, wallet token from the customer backend (installation id as `Idempotency-Key`), push → `sync()` with WorkManager, Auto Backup exclusion, no recovery / re-issue story, expiry semantics, attribute rules link, R8, ABI splits/App Bundles, error table.
- Link it from `services/platform-api/docs/api.md` "Typical flow".

## Order
A0 (fork repo + wrapper mirror + toolchain spike) → F1–F2 committed, F5–F6 → S skeleton (config, key, genesis, onboarding) → first on-device run with the sample (onboarding + connect) → F3–F4 + S offers/proofs/sync/lifecycle → P screens + debug hooks + sample backend → T unit → `smoke:sdk-android` on the phone → D.

## Verification (gate)
- `./gradlew :ariesframework:test :sdk:test :sdk:apiCheck :sample:assembleRelease` green; `publishAllPublicationsToLocalRepository` produces the fork + SDK; the sample resolves both from `build/m2` with **no GitHub token configured**.
- **`smoke:sdk-android` PASSED on the Xiaomi (Android 14)** against staging, steps 1–8, with signed-webhook evidence; mediator logs show no `already processed` errors except in step 7, and 0 duplicate presentations in agent-service.
- Findings recorded in `12id/implement/14-phase-5-android-findings.md` in the 4-init §0.1 tier vocabulary.

## Document updates
- `12id/implement/13-phase-5-android.md` (this plan) and `14-phase-5-android-findings.md`.
- 4-init:
  - §0.1 confirmed/untested lists;
  - §2.7 runtime (fork location, pins);
  - §2.7.4 fork changes 3–6;
  - §4.3 as built;
  - §9 coordinates, wrapper mirror, size numbers;
  - §10 Phase 5 split into **5-Android** (ticked) and **5-iOS** (gated), `registerPushToken` removed;
  - §12.2 → decided (accept loss);
  - new **§12.16** SDK distribution + naming (`com.12id` / `com.onetwoid`, local-only until a public repo);
  - traps found (e.g. invitation URL must be persisted; Keystore + Auto Backup).
- Memory: a Phase 5 project note after the plan is approved.

## Out of scope
iOS/Swift pass and parity suite; public Maven repository and CI release pipeline; wallet backup/export; Java-friendly (non-coroutine) API; `indy-vdr-proxy` holder support (§12.9, only if corporate networks block ports); DIDComm v2 / pickup v2; BLE; platform-sent pushes; Phase 1–4 leftovers.
