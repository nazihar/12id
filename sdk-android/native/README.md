# native — `com.12id:holder-sdk-native`

The three UniFFI wrappers the fork runs on (Askar, AnonCreds, Indy VDR), rebuilt, in one AAR. Customers never
declare it: it comes with `com.12id:holder-sdk-android`. Phase 9 W3 (5b.1), `implement/18-phase-9-production.md`.

| Part | Where | Source |
|---|---|---|
| `lib{askar,anoncreds,indy_vdr}_uniffi.so` for `arm64-v8a`, `armeabi-v7a`, `x86_64` | `jniLibs/` (git-ignored; `build.sh` writes it and `SHA256SUMS`) | built by `build.sh` from upstream [`aries-uniffi-wrappers`](https://github.com/LF-Decentralized-Trust-labs/aries-uniffi-wrappers) at the tag/commit in `versions.env` |
| Kotlin bindings (JNA), packages `askar_uniffi`, `anoncreds_uniffi`, `indy_vdr_uniffi` | `bindings/*.jar` (committed, `bindings/SHA256SUMS`) | the `classes.jar` of the upstream releases `askar_uniffi-android 0.2.0-wrapper.1`, `anoncreds_uniffi-android 0.2.0-wrapper.1` and `indy_vdr_uniffi-android 0.2.1-wrapper.2`, unchanged. Apache-2.0 |

## What differs from upstream

The Rust sources and their `Cargo.lock` are upstream tag `0.2.1` exactly: Askar and AnonCreds are identical
from `0.2.0` to `0.2.1`, and Indy VDR's pool refresh is in `0.2.1`, so this is the source of the three
releases the fork was built and verified against. The bindings are therefore reused as they are: UniFFI checks
its contract version and API checksums when a library loads, so a mismatch would fail on the first call, not
silently.

Only the build is ours:

| Upstream (`cross`) | Here (`cargo-ndk` 4, NDK r27c, API 24) | Why |
|---|---|---|
| compiler-rt builtins missing | `--link-builtins` | the x86_64 libraries imported `__extenddftf2` and failed to load on every Android version (4-init trap 42), which ruled out emulators |
| `libc++_shared.so` shipped next to Indy VDR | libc++ linked statically (`CXXSTDLIB=c++_static`) | a second `libc++_shared.so` in an app fails the build ("2 files found") or mixes C++ runtimes |
| 7 ABIs | 3 (`arm64-v8a`, `armeabi-v7a`, `x86_64`) | x86 is dead; x86_64 is for emulators |
| 4 KB page alignment | 16 KB (`-z max-page-size=16384`) | Android 15+ devices with 16 KB pages, and Google Play for new apps |
| symbols kept | stripped | size |

`build.sh` refuses its own output unless every library needs only `libc`, `libm`, `libdl` and `liblog`, every
imported symbol exists in those libraries' API 24 stubs, and the 64-bit libraries are 16 KB aligned.

## Build

A Linux host: CI (`.github/workflows/native.yml`, on a `native-v*` tag) or, on this PC, the WSL distro
`12id-build` (its disk is on E:, created 2026-09-30; `wsl --unregister 12id-build` removes it):

```
wsl -d 12id-build -u root -- bash -lc 'export ANDROID_NDK_HOME=/opt/android-ndk-r27c NATIVE_WORK=/root/native-work;
  cd /mnt/e/12id-credo/12id/sdk-android/native && bash build.sh'
./gradlew :native:publishReleasePublicationToLocalRepository      # -> build/m2 (fails if jniLibs/ is incomplete)
```

The first build took 65 minutes on 14 cores (OpenSSL and ZeroMQ are compiled from source); a cached rebuild takes about a minute.

## Release

Versions are `<upstream tag>-12id.<n>` (`nativeVersion` in `gradle.properties`). A release is the tag
`native-v<nativeVersion>`, which builds, publishes to the public repository and attaches `SHA256SUMS`. Releases
are rare: only an upstream bump or a build change makes one.

## Bumping upstream

Moving to a newer wrapper release means new bindings as well (0.3.x generates them with Gobley), so it is a
fork change, not only a version edit: update `versions.env`, regenerate the bindings, rebuild, run the fork's
tests, the emulator matrix and `smoke:sdk-android`, and bump `nativeVersion`.
