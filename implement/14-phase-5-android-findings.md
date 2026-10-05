# Phase 5 (Android) — Findings

> **Phase 9 W3 update (2026-10-01):** the open items below are closed.
> - Finding 9: the wrappers were rebuilt with compiler-rt's builtins (`sdk-android/native/`, `com.12id:holder-sdk-native:0.2.1-12id.1`), and x86_64 loads on API 24–37.
> - minSdk 24 is verified on an API 24 emulator, after fork change F8 added the Let's Encrypt roots Android 7.0 lacks.
> - §12.16: public distribution is `https://maven.12id.com` with `com.12id:holder-sdk-android:0.1.0`.
>
> Evidence: `19-phase-9-production-findings.md` W3.

**Plan:** [13-phase-5-android.md](13-phase-5-android.md). **Status: gate passed. `smoke:sdk-android` PASSED on the phone against staging (2026-09-15 09:49–09:52Z), steps 1–7 with signed-webhook evidence; the minified release build onboards on the phone. Open: the minSdk 24 claim cannot be tested (x86_64 wrappers do not load on any Android version; no old arm64 device); public distribution (§12.16).**

Code: `12id/sdk-android/` (fork `ariesframework`, `sdk`, `sample`; `FORK.md`, `docs/integration.md`), `infra/smoke/sdk-android.ts`, `infra/smoke/sdk-sample-backend.ts`, `services/VERSIONS.md`.

| Item | State |
|---|---|
| A0 repository | **done.** `12id/sdk-android/` from `phase0/android` (upstream `e1efb7a` + F1/F2); upstream `app/`, `.github/`, `DEVELOP.md` dropped; `FORK.md` records base and changes |
| A0 wrapper mirror | **done.** `scripts/mirror-uniffi.ps1` copied the three wrapper AARs from the Gradle cache into `third_party/m2` (no token); `CHECKSUMS` committed, AARs git-ignored |
| A0 toolchain | **done.** Gradle 8.14.5 (checksum pinned), AGP 8.13.2, Kotlin 2.2.21, compileSdk 36, ktlint plugin 13.1.0; no framework source changes were needed. AGP 9.4 / Kotlin 2.4 (current on 2026-09-15) not taken: AGP 9 changes the DSL |
| F1–F6 fork changes | **done** (`FORK.md`): optional OOB label, DIDDoc context, restartable pickup, `PickupEvent`, logback out of the library, consumer R8 rules. Plus an slf4j binding **in the SDK** (below) |
| S SDK module | **done.** `com.onetwoid.sdk.OneTwoId` (explicit API mode, fork as `implementation`), Keystore-wrapped wallet key, `noBackupFilesDir` state, genesis fetch + sha256 cache, per-wallet mediator invitation with spent-invitation recovery, `PickUpV1`, offers/proofs surfaced to the host, lifecycle-driven polling, `sync()`, `reset()`. 30/30 JVM tests; `apiDump` committed; `ApiSurfaceTest` refuses framework types |
| P sample app | **done.** Compose UI (connect by paste/QR, credentials, offers, proof requests), `CustomerBackend` stand-in, `SyncWorker` (WorkManager expedited), debug-only `DebugReceiver` for adb. Consumes the SDK only from `build/m2`. arm64 debug 42.7 MB, minified release 28.7 MB |
| T `smoke:sdk-android` | **PASSED** on the Xiaomi 2109119DI (Android 14), run 10 below. Runs 1–9 each found one thing (recorded) |
| T min-SDK check | **blocked.** The wrappers' x86_64 libraries fail to load on API 24, 26, 28 and 36 emulators alike (finding 9); needs an arm64 device on an old Android |
| T release build on device | **done.** The R8-minified arm64 release onboards on the phone (`wallet ready`) |
| D docs | **done.** `sdk-android/docs/integration.md`, `sdk-android/README.md`, `services/VERSIONS.md`; `platform-api/docs/api.md` links the guide |

Every claim below comes from a local run, a device run against staging, or a source read on 2026-09-15.

---

## smoke:sdk-android — PASSED (run 10, the gate)

Device: Xiaomi 2109119DI, Android 14, arm64-v8a; the sample's **debug** build with the SDK from `build/m2`. Nothing compiled in: wallet token from the customer-backend stand-in (`POST /sdk/wallet` behind `smoke-issuer.<domain>`), genesis from `GET /v1/ledger`, mediator invitation from `GET /v1/wallet/mediator-invitation`. Tenant `sdk-smoke-20260915-1509`, cred def `Li96gRWHhe7iHZpmUKwFKp:3:CL:283:default`.

```
=== 1 ONBOARDING (fresh install) ===
  09:49:31.112Z app launched
  09:49:33.097Z backend: wallet 2082e4c5 token issued for installation fa79d6fe
  09:49:34.785Z wallet 2082e4c5 Ready; platform hasMediatorInvitation=true
=== 2 CONNECT ===
  09:49:38.280Z webhook connection.state_changed a3a98ac5 response-sent -> completed
=== 3 OFFER: pending → accept; second offer declined ===
  09:49:41.409Z webhook credential.state_changed d51eff42 · -> offer-sent
  09:49:46.363Z offer pending in the app (1); not auto-accepted
  09:49:50.620Z webhook credential.state_changed d51eff42 credential-issued -> done
  09:49:59.973Z webhook credential.state_changed df952a48 offer-sent -> abandoned      (declined)
=== 4 OFFLINE: process killed in the background, offer, wake webhook, simulated push, sync ===
  09:50:03.729Z app process killed (not force-stopped); waiting 32 s for the wake-up debounce window
  09:50:35.915Z offer sent while the app process was dead
  09:50:36.115Z webhook wallet.sync_requested wallet 2082e4c5
  09:50:41.546Z offline offer collected in the background (state Initializing)
  09:50:47.365Z webhook credential.state_changed cb96066e credential-issued -> done
=== 5 PROOF (template with the automatic expiresAt predicate) ===
  09:51:04.584Z webhook proof.state_changed 5a495dc0 presentation-received -> done
  09:51:15.754Z webhook proof.state_changed 1b1477d5 request-sent -> abandoned         (declined)
=== 6 RESTART === / === 7 SPENT INVITATION (wallet wiped, SDK state kept) ===
  09:51:58.161Z backend: wallet 2082e4c5 token issued for installation fa79d6fe        (second token request = new invitation)
=== smoke:sdk-android results ===
onboarding      : Ready (token requests: 1, invitation minted: true)
connect         : completed (app lists 1 connection(s))
offer           : accepted → done; declined → abandoned
offline         : done, wake webhook at 2026-09-15T09:50:36.115Z
proof           : done verified=true {"employee":{"name":"Ada Lovelace (offline)","department":"Analytical Engines"}}; declined → abandoned
restart         : 2 credentials listed; mediation unchanged=true (wake-ups after restart: false, token re-requested: false)
spentInvitation : Ready after 26 s; new invitation fetched=true
signatures      : all valid
=== smoke:sdk-android PASSED ===
```

App log (`infra/smoke/sdk-android.last.log`) for the two paths that matter:

```
15:50:15.471 D onetwoid-sdk: opened in the background (CREATED): mediator polling paused   ← push-started process
15:50:15.473 I onetwoid-sdk: wallet ready
15:51:33.552 W onetwoid-sdk: mediation failed; retrying once with a new invitation
15:51:33.552 W onetwoid-sdk: java.lang.RuntimeException: Connection to the mediator timed out.   ← spent invitation, 20 s
15:51:34.860 I onetwoid-sdk: wallet ready                                                        ← 1.3 s after the new invitation
```

**What this establishes (confirmed, run):**
- The SDK onboards from nothing but a wallet token: genesis fetched and verified, invitation minted per wallet, mediation over the framework's transport.
- Offers and proof requests **wait for the host app** (`autoAccept… = Never`); accepting an offer stores the credential without further calls; declining sends the problem report and the platform sees `abandoned`.
- **The push path from a dead process:** wake webhook 0.2 s after the offer → simulated push → `SyncWorker` starts the process, `initialize` sees the app is in the background and keeps polling off, `sync()` drains the queue → `done` 11 s after the offer.
- A restart neither re-mediates nor asks for a token; credentials persist.
- **Trap 31 is handled:** a wiped wallet with a spent invitation recovers by itself with one new invitation.
- R8: the minified release build onboards on the phone (separate run, 10:31Z).

## Findings

1. **The wrappers resolve without a GitHub token once mirrored.** The Phase 0 build had already put `askar_uniffi-android 0.2.0-wrapper.1`, `anoncreds_uniffi-android 0.2.0-wrapper.1` and `indy_vdr_uniffi-android 0.2.1-wrapper.2` in the Gradle cache. Only Askar's POM was cached; the script writes the other two with the same dependency list. The fork depends on the `-android` artifacts directly (upstream named the multiplatform roots).
2. **JitPack cannot be dropped:** `org.didcommx:peerdid:0.5.0` needs `com.github.multiformats:java-multibase:v1.1.0`, published only there. Kept, restricted to that group. A consumer of the published SDK needs the wrapper mirror and that JitPack entry too, until the wrappers are republished under our coordinates (§12.16).
3. **Toolchain versions were chosen for Kotlin 2.2 / compileSdk 36, not "latest".** SDK pins: serialization 1.9.0, coroutines 1.10.2, lifecycle-process 2.9.4, okhttp 4.12.0, kotlinx-datetime 0.4.0 (the fork's records expose 0.4 `Instant`s); sample: Compose BOM 2025.09.01, CameraX 1.4.2, ML Kit barcode 17.3.0, WorkManager 2.10.5.
4. **Framework facts that shaped the SDK (source read):** auto-accept is per record (`AcceptOfferOptions(autoAcceptCredential = Always)` makes the framework store and ack the credential on arrival; proofs have no such stamp); the wallet's storage is keyed by `AgentConfig.label`, so the onboarding label is persisted and later changes ignored; the wallet lives in `filesDir/wallet/…` plus the framework's SharedPreferences, both in Auto Backup unless the app excludes them; `LedgerService` ignores `poolName`; offer details are not on the exchange record (read from the stored offer message); `EventBus` has no replay and `waitFor` a hard-coded 20 s timeout; the stored credential id equals the proof candidate `referent`.
5. **The framework was silent, again (trap 16).** F5 removed logback from the library; with no slf4j binding every framework line, including "Pickup messages failed", went nowhere, and run 3's stall (polling stopped after the first poll, cause never seen) could not be diagnosed. The SDK now ships an slf4j 1.7 binding (`org.slf4j.impl.StaticLoggerBinder`) that forwards framework logs to the customer's `LogSink`.

    > **Phase 7 update (2026-09-22, review M14):** forwarding everything was too much. Those debug lines carry proof-request contents and connection records, and a sink usually ends up in a crash reporter. The binding now honours `OneTwoIdConfig.minLogLevel`, which defaults to Info. See [`17-phase-7.md`](17-phase-7.md) M14. Run 3's stall did not recur in runs 4–10.
6. **The holder polls the mediator over https, not the WebSocket.** Visible once framework logs existed: `batch-pickup` goes to `https://mediator…` with return-route, the mediator answers the batch in the HTTP response, and polls land on alternating replicas. The invitation lists `wss` first (still required for the handshake, trap 19); after the connection completes the framework chooses from the mediator's DID document. Unchanged from Phases 1–3, only now observed; it works with `QueueAndLiveModeDelivery` because batch pickup drains the queue regardless of transport.
7. **No wake-up during mediation setup for the Kotlin holder.** The Phase 3 Credo holder produced `wallet.sync_requested` while mediating (queued replies); the Kotlin holder gets its grant back on the return route, so the first wake-up comes with the first organisation message. The smoke's step 1 uses `Ready` + `hasMediatorInvitation` as evidence.
8. **Force-stopped apps get no push — Android's rule, and MIUI adds "Autostart".** `am force-stop` puts the app in the stopped state; broadcasts (and FCM messages) are not delivered until the user opens it. The smoke kills the process with `am kill` instead. On the Xiaomi even that needs MIUI app-op 10008 (`cmd appops set <pkg> 10008 allow`), which `pm clear` resets asynchronously (set it after a pause, read it back). Both are documented for customers in `docs/integration.md`.
9. **The wrappers' x86_64 libraries do not load on any Android version.** `dlopen failed: cannot locate symbol "__extenddftf2" referenced by libaskar_uniffi.so` on API 24, 26, 28 **and 36** x86_64 emulators (the Rust library was linked without compiler-rt's builtins). arm64 works on Android 14. Consequences: no emulator testing until the wrappers are rebuilt (§12.16 work); the sample ships arm64 only; **minSdk 24 is unverified** (needs an arm64 device on Android 7–9). The failure also exposed an SDK bug: `UnsatisfiedLinkError` is an `Error`, so `initialize` left the state at `Initializing`; it now catches `Throwable` and reports `Failed(Internal("native libraries failed to load…"))`.
10. **After a push-started process the app stays in the background with polling off; a proof request sent inside the 30 s wake debounce is collected only when the user opens the app.** Expected behaviour (the platform suppresses a second wake-up), but worth knowing: the smoke launches the app before step 5.
11. **The platform-api → agent-service client times out at 10 s;** one cred-def publication on staging took longer (run 7, 502 `agent_unreachable`, both services healthy). Reuse `CRED_DEF_ID` across smoke runs; a longer timeout for catalogue writes is a platform follow-up.
    > **Phase 7 update (2026-09-22, review M5):** the diagnosis was wrong.
    > - The client's default was already 30 s.
    > - The real cause was agent-service's internal API, `connectionTimeout: 10_000`, a socket idle timeout that killed the connection while the handler waited on the ledger.
    > - Fixed: `connectionTimeout: 0`, `requestTimeout: 30_000`, plus a 90 s client timeout for ledger calls.
    > - A test that holds a handler silent for 11 s fails on the old code and passes on the new. `smoke:platform-credo` PASSED.
    > - `CRED_DEF_ID` reuse is no longer needed.
    > - See [`17-phase-7.md`](17-phase-7.md) M5.
12. **Sizes.** arm64 debug APK 42.7 MB (Phase 0 sample: 51.7 MB); minified release 28.7 MB, mostly the three native libraries. The fork AAR itself is 1.5 MB.

## Left open

- minSdk 24 verification on an arm64 device running Android 7–9 (finding 9).
- Rebuild the UniFFI wrappers (static compiler-rt builtins, our coordinates) and publish SDK + fork + wrappers to a public repository (§12.16); until then customers need three repositories.
- The Swift/iOS pass and the parity suite (unchanged).
- Platform follow-up: catalogue write timeout (finding 11).
