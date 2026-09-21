# Pinned component versions

Pin each component explicitly and test the combination (4-init §7.1; the versions are not equal
across components and need not be). Update this file with every bump.

| Component | Version | Where pinned | Interop verified |
|---|---|---|---|
| agent-service, endorser-service, platform-api | Credo-TS 0.7.0 (`@credo-ts/*` 0.7.0, askar-nodejs 0.6.0, anoncreds-nodejs 0.4.0, indy-vdr-nodejs 0.3.0) | `services/*/package.json` | Phases 2–5 on staging |
| Mediator | `12id/mediator:375518d-p2` = upstream image `375518d` (Credo 0.6.0) + two patched files | `infra/staging/mediator/` | Phases 1–5 on staging |
| Ledger | von-network (4 nodes on the staging VM), genesis `https://genesis.<domain>/v1/…` | `infra/staging/compose.ledger.yml` | — |
| Console | TanStack Start 1.168.54, Better Auth 1.7.4 (full list in `12id/implement/12-phase-4-findings.md`) | `console/package.json` | Phase 4 |
| Android holder framework (fork) | upstream `LF-Decentralized-Trust-labs/aries-framework-kotlin` **`e1efb7a`** + changes F1–F6 (`sdk-android/FORK.md`); published as `com.12id:aries-framework-kotlin:2.0.0-12id.1` | `sdk-android/gradle.properties` (`forkVersion`) | Phase 5 `smoke:sdk-android` on the phone |
| Android UniFFI wrappers | `org.hyperledger:askar_uniffi-android:0.2.0-wrapper.1`, `anoncreds_uniffi-android:0.2.0-wrapper.1`, `indy_vdr_uniffi-android:0.2.1-wrapper.2`, mirrored (`sdk-android/third_party/m2/CHECKSUMS`) | `sdk-android/ariesframework/build.gradle` | arm64-v8a only (x86_64 libraries do not load; Phase 5 findings) |
| Android SDK | `com.12id:holder-sdk-android:0.1.0` (package `com.onetwoid.sdk`); Gradle 8.14.5, AGP 8.13.2, Kotlin 2.2.21, compileSdk 36, minSdk 24 (arm64 proven on Android 14 only) | `sdk-android/gradle.properties` (`sdkVersion`), `build.gradle` | Phase 5 |
| biometric-service (Phase 6) | Node 22 + Fastify 5.12.4, drizzle 0.45.2; `@aws-sdk/client-rekognition` and `@aws-sdk/client-sts` **3.1136.0** | `services/biometric-service/package.json` | `smoke:biometric-credo` (mock) on staging, 2026-09-21 |
| Android biometric add-ons (Phase 6) | `com.12id:holder-sdk-android-biometrics-aws:0.1.0` = Amplify UI Liveness **1.11.0** (brings Amplify 2.38.1, Guava 33.3.1, LiteRT 1.4.1; needs core library desugaring in the app); `…-biometrics-mock:0.1.0` (debug/testing) | `sdk-android/biometrics-aws/build.gradle` | mock: `smoke:sdk-biometric-android` on the phone; AWS: pending the tenant role (16-phase-6-biometric-findings.md) |
