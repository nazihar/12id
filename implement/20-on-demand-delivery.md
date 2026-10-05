# On-demand message delivery (Android SDK 0.2.0)

**Status (2026-10-05):** built, unit-tested, and **both phone smokes passed** (`smoke:sdk-android` all steps, `smoke:sdk-biometric-android` 12/12).
- **Not tagged yet:** `sdk-android-v0.2.0` waits for the owner (commit, push, tag; publishing a version to maven.12id.com cannot be undone).
- The code and the API dump are done. SDK 66/66 and fork 10/10 unit tests pass, `apiCheck` is clean, and the sample builds against 0.2.0 from `build/m2`.
- The smokes are updated and type-check.

**No platform change.** platform-api, the mediator and infra are untouched, and production deploys `v0.1.0` as planned.

## Why
**Before:** while the app was in the foreground, the SDK polled the mediator every 10 s with `PickUpV1`. The timer was the framework's own (`MediationRecipient.initiateMessagePickup`) and started inside `agent.initialize()`.

In the target apps an offer arrives once or twice in a lifetime and proof requests are rare, so nearly every poll came back empty. Those polls:
- were almost all of the mediator's load: Phase 9 W4 measured about 22 ms of CPU per poll, so 10k open apps ≈ 30 cores;
- leaked "this app is open" every 10 s to the mediator (4-init §2.3);
- still left each message waiting 0–10 s.

**Every message comes from something the customer's backend started:**
- the app asked for it (sign-in → offer, an action → proof), so the app knows when to look;
- or the organisation sent it on its own, so the push path delivers it (`wallet.sync_requested` → FCM → `sync()`).

**Owner decisions (2026-10-05):**
- Plan only this.
- `idlePollInterval` is opt-in, off by default.
- **The wake-up debounce gap is closed in the SDK (sync tail), not in the platform.**
  - Considered and rejected: a platform trailing wake-up plus a check of the mediator queue before waking.
  - Its cost: about 1.5 d, `platform_ro` read access to the mediator's internal `queued_message` table, a new secret, a 1 s ticker with its own alert, and about 3 s slower background wake-ups.
  - Its benefit: saving about one free silent push per in-app exchange, which already happened before this change.

## What changed
| Part | Change |
|---|---|
| Fork F9 (`routing/MediationRecipient.kt`) | `mediatorPollingInterval <= 0` starts no pickup timer after mediation (`pollingPeriodMillis`, `PollingPeriodTest`) |
| `internal/PickupRunner.kt` (new) | The SDK's only path to the mediator. A mutex serialises every pickup (there was none). `batch()` subscribes to `PickupEvent` before sending and fails after 15 s, because a failed send is swallowed by the framework. `drain()` repeats until a batch comes back empty |
| `internal/DeliveryScheduler.kt` (new) | **Windows**: 1 s × 5, then 2 s, until the expected event or the timeout; a full batch (10) is followed at once by another pickup. **Foreground drain**: once per `onStart`. **Sync tail**: polls at +10 s, +20 s and +32 s. **Opt-in idle polling**: foreground only. Pure coroutine logic, tested on virtual time |
| `OneTwoId` | `mediatorPollingInterval = 0`.<br>The lifecycle calls `onForeground()` / `onBackground()`.<br>`connect` opens a window until `ConnectionCompleted` for that connection; `acceptOffer` until `CredentialStored` / `ExchangeFailed` for that offer.<br>New `expectMessages(timeout = 30 s, max 120 s)` ends at the first offer, proof request or failure.<br>`sync()` drains through `PickupRunner`, then starts the tail.<br>New `awaitDelivery()` (for push workers).<br>One Info log line per pickup (`mediator pickup (<reason>)`) |
| `OneTwoIdConfig` | `idlePollInterval: Duration? = null`, at least 10 s (`checkIdlePollInterval`) |
| Sample | `EXPECT` debug action; `SyncWorker` calls `awaitDelivery()` after `sync()` |
| Version | `sdkVersion=0.2.0`, which also applies to the biometric add-ons |

**Binary compatibility:** the 0.1.0 API is kept exactly; the API dump differs from 0.1.0 by additions only.
- `idlePollInterval` comes through a second `OneTwoIdConfig` constructor, where it is required, plus a read-only property.
- The first phone run showed why: a sixth constructor parameter with a default had replaced the 0.1.0 constructor. The sample, compiled against 0.1.0 by a stale incremental build, then failed with `NoSuchMethodError` in `initialize`.
- A customer library compiled against 0.1.0 would fail the same way.

**Proof responses open no window.** The verifier's acknowledgement goes through the mediator, and the mediator fires its push webhook when the acknowledgement is queued, whether or not the app collects it. So a window there would buy nothing. The acknowledgement waits for the next drain.

## Behaviour
| Situation | Before (0.1.0) | Now (0.2.0) |
|---|---|---|
| App open, idle | a poll every 10 s | no requests |
| App asks its backend, then calls `expectMessages()` | 0–10 s | about 1–2 s (first poll after 1 s) |
| Organisation sends while the app is open | 0–10 s | with the push (about 3–5 s), or at the next foreground |
| Organisation sends while the app is in the background or killed | push → `sync()` | the same, plus the tail for a second message inside the 30 s debounce (before: lost until the next launch, Phase 5 finding 10) |
| App comes to the foreground | the timer's first poll | one drain |

## Verification
**Unit tests (2026-10-05):**
- `:ariesframework:testReleaseUnitTest` 10/10, including `PollingPeriodTest` 2.
- `:sdk:testReleaseUnitTest` 66/66:
  - `DeliverySchedulerTest` 15: idle silence, window cadence, ends on match and at timeout, unrelated events, full batch, shared loop, foreground drain, tail timing and restart, tail skipped during a window, idle opt-in in the foreground only, windows survive the background, `awaitIdle`, a failing pickup.
  - `PickupRunnerTest` 6.
  - `LoggingAndConfigTest` +1.
- `:sdk:apiCheck` clean after `apiDump`. `:sample:assembleDebug` builds against 0.2.0.

**Trap:** `kotlinx-coroutines-test`'s `advanceUntilIdle()` ignores work in `backgroundScope`. The scheduler tests advance virtual time explicitly.

**Smokes (updated):**
- `smoke:sdk-android`:
  - step 3: `EXPECT` before the first offer; the second offer goes over the push while the app is open;
  - new 3b: 0 pickups in 60 s while the app is open and idle;
  - new 3c: an offer sent while the app is in the background with no push, drained when it opens;
  - step 4: a second offer inside the debounce, collected by the tail with exactly one wake-up;
  - step 5: `EXPECT` before each proof request, with timings printed.
- `smoke:sdk-biometric-android`: `EXPECT` before each offer and the proof request.

**Phone, 2026-10-05: `smoke:sdk-android` PASSED (all steps)** on Xiaomi `lisa`, Android 14, against staging (platform `v0.1.0`). The sample was built clean from `build/m2` at 0.2.0. Run `sdk-1791200552897`.

| Step | Result |
|---|---|
| 1 Onboarding | Ready, 1 token request, invitation minted |
| 2 Connect | `completed` through the `connect` window |
| 3 Offer | with `EXPECT`, in the app **2.1 s** after the API call; accepted → `done`. The offer pushed while the app was open → declined → `abandoned` |
| 3b Idle | **0 pickups in 60 s** with the app open |
| 3c Foreground drain | offer sent in the background without a push, collected **2.2 s** after the app opened |
| 4 Offline | killed app: offer → 1 wake-up → push → `sync()` collected it. The second offer, inside the debounce, was collected **by the tail 23.0 s** after it was sent, with **1 wake-up** in total. Both `done` |
| 5 Proof | with `EXPECT`, in the app after **2.7 s**; `done` and `verified=true` after 7.5 s, including the smoke's adb round trips; second request declined → `abandoned` |
| 6 Restart | 3 credentials; mediation unchanged; no wake-up and no token request |
| 7 Spent invitation | Ready after 26 s with a new invitation |

- All webhook signatures were valid.
- The app log has 59 pickups over the run: window 42, tail 7, foreground 6, sync 4. The 10 s timer would have made about 40 in the same time, mostly empty, and here the bulk of the run was exchanges.
- **Transport:** not determined. The framework logs endpoints only at Debug, and the sample logs at Info. It doesn't affect the design.

**`smoke:sdk-biometric-android` (mock) PASSED 12/12** on the same phone, tenant "Biometric Smoke": the gated offer is refused before the check and issued after the pass; a failed match keeps 2 attempts; the gated proof request is collected in the `EXPECT` window and released after the pass (`verified`, disclosed); the attempt is in the log.

**Found on the phone:**
- **The 0.1.0 constructor must be kept** (see Binary compatibility). The first run failed at onboarding with `NoSuchMethodError`, until the sixth constructor parameter moved to a second constructor and the sample was rebuilt clean.
- **Bursts of wallet-token requests.** The push-woken process asked the stand-in backend for a token at +0 s and +11 s. After the two background accepts it asked four times within 64 ms.
  - `PlatformClient` already caches the token and lets only one caller fetch at a time (`tokenMutex`, Phase 6). So a burst is most likely a cascade of 401 responses after a rotation: each `POST /v1/wallets` retry rotates the token. That is not proven.
  - It is not caused by 0.2.0: W3 saw five token requests in a push-woken process.
  - The smoke passed anyway.
  - **Follow-up:** log the 401s in `authorized()` and find which call rejects the cached token.

**Optional:** window-mode load (`infra/load/poll.ts --mode window`), to size the production mediator by exchanges per second instead of open apps.

## Docs
- **Customer:** `sdk-android/docs/integration.md`:
  - the Push row;
  - `expectMessages` / `awaitDelivery` in "Everyday calls";
  - "Delivery: when the wallet collects messages" rewritten, with the no-push option `idlePollInterval`;
  - new "Recipe: issue at sign-in, prove before an action".

  `services/platform-api/docs/api.md` `wallet.sync_requested`: the tail, no more "right after first launch", and the backend side of the recipe. `data-protection.md`: the mediator metadata sentence. `docs/site/build.sh` assembles cleanly.
- **The Gradle snippets still say `0.1.0`:** bump them with the tag. docs.12id.com republishes on the push to master.
- **Internal:** dated back-notes in `4-init-post-phase-0.md` (§2.3, §2.7, §2.7.3, §2.7.4, §3, §4.3, §4.8, §10), `13-phase-5-android.md`, `14-phase-5-android-findings.md` (finding 10) and `18-phase-9-production.md` (W6); `sdk-android/FORK.md` F9; `services/VERSIONS.md`.

## For iOS (W6)
Mirror this model:
- no timer;
- windows after `connect` / `acceptOffer` / `expectMessages`;
- a drain on foreground;
- `sync()` plus a 32 s tail.

iOS throttles silent background pushes, so the drain on foreground carries more of the delivery there.
