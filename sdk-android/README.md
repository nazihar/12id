# 12id Android holder SDK

| Module | What | Published as |
|---|---|---|
| `sdk/` | The customer-facing SDK, package `com.onetwoid.sdk` (`docs/integration.md`) | `com.12id:holder-sdk-android` |
| `ariesframework/` | Vendored fork of `aries-framework-kotlin` (`FORK.md`); its sources compile into `sdk/`, the module keeps the fork's tests | inside `com.12id:holder-sdk-android` |
| `native/` | The rebuilt UniFFI wrappers (Askar, AnonCreds, Indy VDR) and their bindings (`native/README.md`) | `com.12id:holder-sdk-native` (comes with the SDK) |
| `biometrics-aws/`, `biometrics-mock/` | Face-capture add-ons (Phase 6) | `com.12id:holder-sdk-android-biometrics-{aws,mock}` |
| `third_party/java-multibase/` | Vendored `java-multibase` (only on JitPack), compiled into the SDK | — |
| `sample/` | Example app; consumes the SDK from the local Maven repository like a customer would; its debug build is driven by `infra/smoke/sdk-android.ts` | — |

## Build

```
./gradlew :ariesframework:test :sdk:test :sdk:apiCheck
./gradlew :sdk:publishReleasePublicationToLocalRepository   # -> build/m2 (the sample does this itself)
./gradlew :sample:assembleDebug :sample:assembleRelease
```

The sample takes `com.12id:holder-sdk-native` from `build/m2` if `native/build.sh` ran here (a Linux host,
`native/README.md`), otherwise from `https://maven.12id.com`. `local.properties` needs `sdk.dir`. JDK 17, Gradle 8.14.5 (wrapper), AGP 8.13.2, Kotlin 2.2.21.

## Public API changes

`sdk/api/sdk.api` is the API dump kept by the binary-compatibility-validator: run `./gradlew :sdk:apiDump`
after an intended change and commit the result; `apiCheck` fails on drift. `ApiSurfaceTest` refuses any
framework type in the public API.

## Smoke

`cd ../infra && node smoke/sdk-android.ts` with a phone attached, the `smoke-issuer` tunnel open and
`PLATFORM_API_KEY` set (see the script header). Steps 1–7 of the Phase 5 plan; the app log is saved to
`smoke/sdk-android.last.log`.
