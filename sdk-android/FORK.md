# sdk-android — fork record

`ariesframework/` is a vendored fork of
[`LF-Decentralized-Trust-labs/aries-framework-kotlin`](https://github.com/LF-Decentralized-Trust-labs/aries-framework-kotlin).

| | |
|---|---|
| Upstream base | `e1efb7a` ("issue credential 2.0 (#37)") |
| Vendored on | 2026-09-15, from the Phase 0 clone `phase0/android` |
| Upstream sample `app/` | removed; replaced by `sample/` |
| Published as | inside `com.12id:holder-sdk-android`: its sources compile into `:sdk` (Phase 9 W3, 4-init §12.16). `com.12id:aries-framework-kotlin` (Phase 5) is no longer published |

## Changes against upstream

Every change is marked in the source with a `fork change` comment (`Phase 0 fork change` for F1–F2, `12id fork change` after that). Keep this table in step.

| # | File | Change | Why |
|---|---|---|---|
| F1 | `oob/messages/OutOfBandInvitation.kt` | `label` defaults to `""` | RFC 0434 makes it optional; the mediator's invitation omits it, and parsing failed (4-init §2.7.4) |
| F2 | `connection/models/didauth/DidDoc.kt` | `@context` is `https://www.w3.org/ns/did/v1` | The Credo 0.6 mediator rejects `https://w3id.org/did/v1`; unnecessary once the mediator is on 0.7 |
| T1 | `build.gradle`, `ariesframework/build.gradle`, `gradle/wrapper` | Gradle 8.0 → 8.14.5 (checksum pinned), AGP 8.0.2 → 8.13.2, Kotlin 1.8 → 2.2.21, compileSdk 33 → 36, library `targetSdk` removed, `kotlinOptions` → `kotlin.compilerOptions`, ktlint plugin 11.4.2 → 13.1.0. No source changes were needed | compileSdk 36 for current customer apps (Phase 5 plan) |
| F3 | `routing/MediationRecipient.kt` | public `startPickup()` / `stopPickup()`; `close()` delegates to `stopPickup()`; the polling timer is never started twice | Phase 5: the SDK paused polling in the background and resumed it in the foreground; upstream could only stop it for good. Since F9 the SDK runs no timer and no longer calls them |
| F4 | `agent/AgentEvents.kt`, `routing/MediationRecipient.kt` | `AgentEvents.PickupEvent(messageCount)` published after every pickup batch | `sync()` needs to know when the mediator's queue is drained |
| F5 | `ariesframework/build.gradle` | `logback-classic` is test-only | A library must not force a logging backend |
| F6 | `ariesframework/consumer-rules.pro` | R8 keep rules for the framework's serializable models, the UniFFI bindings and JNA | Apps that minify would otherwise strip classes resolved by name at runtime (verified by the sample's minified release build) |
| F7 | `ariesframework/build.gradle` | The UniFFI wrappers come from `:native` (rebuilt, `native/README.md`) instead of the `org.hyperledger` artifacts; `java-multibase` is vendored (`third_party/java-multibase`) instead of resolved from JitPack; androidx core/appcompat and Material dropped (unused); no publication of its own | Phase 9 W3: one repository for consumers, and x86_64 libraries that load |
| F8 | `agent/IsrgTrust.kt` (new), `agent/OutboundTransport.kt`, `oob/InvitationUrlParser.kt` | The Let's Encrypt roots (ISRG X1, X2, YE, YR) as a fallback after the system trust store, on the framework's HTTP/WebSocket client and the invitation short-URL fetch; the SDK's `PlatformClient` uses it too | minSdk 24: Android 7.0 predates ISRG Root X1 and could not validate any Let's Encrypt certificate (Phase 9 W3) |
| F9 | `routing/MediationRecipient.kt` | `mediatorPollingInterval <= 0` starts no pickup timer after mediation (`pollingPeriodMillis`, `PollingPeriodTest`); `pickupMessages()` is unchanged | On-demand delivery (2026-10-05, `implement/20-on-demand-delivery.md`): the SDK decides when to poll (windows, foreground drain, sync) and sets the interval to 0. F3 stays for apps that set an interval |

The slf4j binding that makes the framework's logs visible lives in the SDK (`sdk/src/main/java/org/slf4j/impl/`), not in the fork.

No further changes are planned; add a row for anything a smoke run forces.

## Updating from upstream

Diff upstream `main` against `e1efb7a`, re-apply the table above, rerun `:ariesframework:test` and `smoke:sdk-android`, then update the base commit here and in `services/VERSIONS.md`.
