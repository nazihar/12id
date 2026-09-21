# 12id Android SDK — integration guide

The SDK (`com.12id:holder-sdk-android`, package `com.onetwoid.sdk`) turns your Android app into the
holder of credentials issued through the 12id platform. Your backend talks to the platform API
(`services/platform-api/docs/api.md`); the SDK talks to it only for two things — the ledger
configuration and its mediator invitation — and everything else runs over DIDComm between the wallet
on the phone, the mediator and the issuing organisation. No credential or key ever leaves the device.

## Requirements

| | |
|---|---|
| Android | `minSdk 24`. Verified on Android 14, arm64-v8a. **x86_64 emulators do not work** (the native libraries fail to load); test on an arm64 device or an arm64 emulator |
| Language | Kotlin with coroutines (every SDK call is a `suspend` function) |
| Size | the sample's minified arm64 release APK is 28.7 MB, most of it the three native libraries (Askar, AnonCreds, Indy VDR). Ship an App Bundle or ABI splits; `ndk.abiFilters` has no effect because the native libraries arrive inside AARs |
| Push | optional but strongly recommended: your backend receives `wallet.sync_requested` and pushes the app, which calls `OneTwoId.sync()` |

## Gradle

The SDK is currently distributed from a local Maven repository (`sdk-android/build/m2`, produced by
`./gradlew publishAllPublicationsToLocalRepository`); a public repository follows. The published
artifact still depends on the `org.hyperledger` UniFFI wrappers and on one JitPack artifact, so a
consumer declares three repositories:

```groovy
// settings.gradle
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven { url = uri("<path or URL of the 12id repository>"); content { includeGroup("com.12id") } }
        maven { url = uri("<path or URL of the wrapper mirror>"); content { includeGroup("org.hyperledger") } }
        maven { url = uri("https://jitpack.io"); content { includeGroup("com.github.multiformats") } }
    }
}

// app/build.gradle
dependencies {
    implementation("com.12id:holder-sdk-android:0.1.0")
}
android {
    splits { abi { enable true; reset(); include "arm64-v8a"; universalApk false } }   // or an App Bundle
}
```

R8/ProGuard rules ship with the SDK (consumer rules); nothing to add.

## Initialise once

```kotlin
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CoroutineScope(Dispatchers.Default).launch {
            OneTwoId.initialize(this@MyApp, OneTwoIdConfig(
                apiBaseUrl = "https://api.12id.example",
                walletTokenProvider = { myBackend.walletToken(installationId) },
                label = "Acme Wallet",                       // what organisations see; fixed at first launch
                logSink = { level, message, error -> Log.println(level.priority(), "12id", message) },
            ))
        }
    }
}
```

- `initialize` is idempotent and safe to call from anywhere; it opens the wallet, and on the first
  launch creates it, fetches the ledger genesis (verified by checksum) and connects to the mediator.
- **Wallet token.** Your backend creates one wallet per app installation with `POST /v1/wallets`,
  sending the app's installation id (a UUID you generate once and keep) as `Idempotency-Key`, and
  returns `walletToken` to the app. A retry of that call returns the same wallet with a *new* token,
  so the provider should always fetch the latest one; the SDK calls it again once when the platform
  rejects a token. The app never holds a platform API key.
- Observe `OneTwoId.state` (`Uninitialized`, `Initializing`, `Ready`, `Failed(error)`).

## Everyday calls

| Call | What it does |
|---|---|
| `connect(invitationUrl)` | Accepts an organisation's invitation (the URL behind its QR code). Completion arrives as `WalletEvent.ConnectionCompleted` |
| `connections()` | Pairwise connections with organisations |
| `pendingOffers()` / `acceptOffer(id)` / `declineOffer(id)` | Credential offers wait for the user. After `acceptOffer` the credential is stored automatically when it arrives (`WalletEvent.CredentialStored`) |
| `credentials()` / `credential(id)` | Stored credentials with their attributes and `expiresAtEpochSeconds` |
| `pendingProofRequests()` / `proofRequestOptions(id)` / `respondToProofRequest(id, selection)` / `declineProofRequest(id)` | Proof requests wait for the user. `proofRequestOptions` lists, per requested group, the stored credentials that can answer it; `ProofRequestOptions.defaultSelection()` picks the first of each. `WalletEvent.ProofSent` follows |
| `sync()` | Collects messages queued at the mediator now. Call it from your push handler (below) |
| `reset()` | Deletes the wallet, its key and the SDK state. Credentials are gone for good; organisations re-issue them |
| `events` / `addListener` | `WalletEvent`s: `OfferReceived`, `CredentialStored`, `ProofRequested`, `ProofSent`, `ConnectionCompleted`, `ExchangeFailed` |

Every call throws an `OneTwoIdException` subtype: `NotInitialized`, `WalletTokenRejected`,
`NetworkUnavailable`, `PlatformError`, `InvalidInvitation`, `MediatorUnavailable`,
`LedgerUnavailable`, `NotFound`, `InvalidSelection`, `WalletKeyLost`, `Internal`.

## Delivery: foreground polling and push

While the app is in the foreground the SDK polls the mediator every 10 s, so offers and proof requests
appear within that time. In the background it stops polling (battery), and messages queue at the
mediator. To deliver them:

1. The platform sends your backend a signed `wallet.sync_requested` webhook (`data.walletId`,
   `data.externalId`; at most one per wallet per 30 s). It also fires right after first launch and can
   fire while the app is open: treat it as "sync now", not "a credential arrived".
2. Your backend sends a silent push to that installation with your own FCM setup.
3. Your push handler calls `sync()`; do it from WorkManager expedited work so it survives the handler:

```kotlin
class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        OneTwoId.initialize(applicationContext, MyApp.config)   // no-op when already open
        val result = OneTwoId.sync()                            // returns counts; drained=false on timeout
        return Result.success()
    }
}

// FirebaseMessagingService
override fun onMessageReceived(message: RemoteMessage) {
    if (message.data["type"] == "wallet.sync_requested") {
        WorkManager.getInstance(this).enqueueUniqueWork("12id-sync", ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<SyncWorker>().setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST).build())
    }
}
```

`sync()` works from a process the push just started, using the configuration of the last `initialize`.
Two Android facts to know:

- An app the user **force-stopped** (Settings → Force stop, or some OEM "clean-up" tools) is in the
  stopped state and receives no push until the user opens it again. That is Android's rule, not the
  SDK's; the messages stay queued and are collected on the next launch.
- **Xiaomi/MIUI** additionally needs the app's "Autostart" permission to start a killed app for a push.
  Without it, delivery waits for the next launch as well.

## Backups: exclude the wallet

The wallet's key lives in the Android Keystore and never leaves the device, so wallet files restored
onto another device (Auto Backup, device-to-device transfer) cannot be opened: the SDK reports
`WalletKeyLost` and the app must call `reset()`. Avoid the situation by excluding the wallet from
backups. The SDK's own state is already in `noBackupFilesDir`; add for the framework's files:

```xml
<!-- res/xml/data_extraction_rules.xml (Android 12+) -->
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="file" path="wallet" />
        <exclude domain="sharedpref" path="aries-framework-kotlin.xml" />
    </cloud-backup>
    <device-transfer>
        <exclude domain="file" path="wallet" />
        <exclude domain="sharedpref" path="aries-framework-kotlin.xml" />
    </device-transfer>
</data-extraction-rules>
<!-- res/xml/backup_rules.xml (Android 11 and older): the same two excludes in <full-backup-content> -->
```

and reference both from `<application android:dataExtractionRules=… android:fullBackupContent=…>`.

## No recovery, no revocation

- **A lost phone means a lost wallet.** There is no backup or export in this version: after a reinstall
  or a new device the app onboards a new wallet and organisations issue credentials again. Design your
  onboarding so re-issuance is one step for the user.
- **Credentials cannot be revoked**; they carry an `expiresAt` attribute (epoch seconds) that every
  verifier checks with a predicate, so a credential simply stops being accepted at that time.
  `Credential.isExpired()` tells you when to prompt for renewal. Attribute values are strings; see the
  platform guide for the encoding rules.

## Biometric checks (face liveness + match)

Some organisations require a face check before they issue a credential or accept a proof: the user
proves they are live and match a reference photo the organisation holds. The SDK knows which offers and
requests need it; the camera screen comes from a **capture add-on** for the organisation's vendor.

**1. Add the add-on for your organisations' vendor** (one artifact per vendor, same version as the SDK):

```groovy
dependencies {
    implementation "com.12id:holder-sdk-android:0.1.0"
    implementation "com.12id:holder-sdk-android-biometrics-aws:0.1.0"   // AWS Rekognition Face Liveness
}

android {
    compileOptions {
        // Required by the AWS add-on (its Amplify dependencies use Java 8+ APIs).
        coreLibraryDesugaringEnabled true
    }
}
dependencies { coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5' }
```

The AWS add-on adds about 8 MB to an arm64 release APK. It declares the `CAMERA` permission and asks
for it when the check starts. If your app also uses CameraX directly and fails to compile with
"Cannot access class 'ListenableFuture'", add `implementation 'com.google.guava:guava:33.3.1-android'`
(the add-on already brings it at runtime).

**2. Register it once**, next to `initialize`:

```kotlin
OneTwoId.registerCapture(AwsFaceLivenessCapture())
```

**3. Check before accepting.** `CredentialOffer.biometric` and `ProofRequest.biometric` are set when a
check is required:

```kotlin
val offer = OneTwoId.pendingOffers().first()
if (offer.biometric?.status == BiometricStatus.Pending) {
    when (val outcome = OneTwoId.verifyFace(activity, offer.id)) {   // shows the vendor's screen
        BiometricOutcome.Passed -> OneTwoId.acceptOffer(offer.id)
        is BiometricOutcome.Failed -> showRetry(outcome.attemptsRemaining)
        BiometricOutcome.Locked -> showCancelled()                   // the organisation cancels the exchange
    }
} else {
    OneTwoId.acceptOffer(offer.id)
}
```

Proof requests work the same way with `respondToProofRequest`. Each `verifyFace` call uses one attempt.
`acceptOffer` / `respondToProofRequest` throw `BiometricRequired` while the check has not passed. That
is a convenience: the platform itself holds the credential (or withholds the proof result from the
organisation) until the check passes, whatever the app does.

| Exception | Meaning |
|---|---|
| `BiometricRequired` | Call `verifyFace` first |
| `BiometricCaptureUnavailable(provider)` | Your app does not include the add-on for this organisation's vendor |
| `BiometricCancelled` | The user left the capture screen |
| `BiometricFailed` | No attempts left, or the check expired |

**Switching vendor** is the organisation's decision, but your app must ship the new add-on first. The
organisation's console shows how many of your installations report each add-on.

The SDK never sees the result or any image: the vendor streams to the organisation's own vendor
account, and the platform reads the result from there.

## Sample app

`sdk-android/sample/` is a complete example: `SampleApp` (initialise + token provider),
`CustomerBackend` (stand-in for your backend), `SyncWorker` (push path), Compose screens for
connecting (paste or scan a QR), offers, credentials and proof requests. Its debug build also has the
adb-driven hooks used by `infra/smoke/sdk-android.ts`.
