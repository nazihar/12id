# 12id Android SDK — integration guide

The SDK (`com.12id:holder-sdk-android`, package `com.onetwoid.sdk`) turns your Android app into the
holder of credentials issued through the 12id platform. Your backend talks to the platform API
(`services/platform-api/docs/api.md`); the SDK talks to it only for two things — the ledger
configuration and its mediator invitation — and everything else runs over DIDComm between the wallet
on the phone, the mediator and the issuing organisation. No credential or key ever leaves the device.

## Requirements

| | |
|---|---|
| Android | `minSdk 24`. Native libraries for `arm64-v8a`, `armeabi-v7a` and `x86_64` (emulators), 16 KB page aligned. Verified on Android 14 (arm64-v8a) and on x86_64 emulators at API 24, 26, 28 and 36 |
| Android 7.0 (API 24) | Its trust store predates Let's Encrypt's root (ISRG Root X1). The SDK carries the Let's Encrypt roots for its own connections, so it works there unchanged. If **your app** also calls your own server with a Let's Encrypt certificate, add the same roots to your app's network security config (the sample does: `sample/src/main/res/xml/network_security_config.xml` and `res/raw/isrg_root_*.pem`) |
| Language | Kotlin with coroutines (every SDK call is a `suspend` function) |
| Size | most of an app's added size is the three native libraries (Askar, AnonCreds, Indy VDR, in `com.12id:holder-sdk-native`, which comes with the SDK). Ship an App Bundle or ABI splits so each device downloads one ABI |
| Push | strongly recommended: your backend receives `wallet.sync_requested` and pushes the app, which calls `OneTwoId.sync()`. Without push, messages an organisation sends on its own arrive the next time the app comes to the foreground (see [Delivery](#delivery-when-the-wallet-collects-messages)) |

## Gradle

The SDK is published to the 12id Maven repository, `https://maven.12id.com`. Declare it once, next to
Google and Maven Central, and add one dependency; the native libraries (`com.12id:holder-sdk-native`) come
with it:

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven("https://maven.12id.com") { content { includeGroup("com.12id") } }
    }
}

// app/build.gradle.kts
dependencies {
    implementation("com.12id:holder-sdk-android:0.2.0")
}
android {
    splits { abi { isEnable = true; reset(); include("arm64-v8a", "armeabi-v7a", "x86_64"); isUniversalApk = false } }  // or an App Bundle
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
                // minLogLevel = LogLevel.Debug,                // diagnosing only; see below
            ))
        }
    }
}
```

- **`apiBaseUrl` must be https.** A release build refuses anything else with `InvalidConfiguration`:
  the wallet token travels on it, and Android blocks cleartext by default only from API 28. A debuggable
  build may use `http://` for a local platform API.
- **`logSink` receives Info and above by default.** Set `minLogLevel = LogLevel.Debug` only while
  diagnosing, and never in a release build: framework debug lines carry proof-request contents,
  connection records and DID documents, and a sink usually ends up in a crash reporter.
- `initialize` is idempotent and safe to call from anywhere; it opens the wallet, and on the first
  launch creates it, fetches the ledger genesis (verified by checksum) and connects to the mediator.
- **Wallet token.** Your backend creates one wallet per app installation with `POST /v1/wallets`,
  sending the app's installation id (a UUID you generate once and keep) as `Idempotency-Key`, and
  returns `walletToken` to the app. A retry of that call returns the same wallet with a *new* token,
  so the provider should always fetch the latest one; the SDK calls it again once when the platform
  rejects a token. The app never holds a platform API key.
- **Revoked wallets.** If your backend's `POST /v1/wallets` answers `409 wallet_revoked`, the wallet for
  that installation was revoked. You did it, or 12id did because it never connected to the mediator
  within 7 days. Create a new wallet with a new `Idempotency-Key` and return its token; the SDK then
  onboards again. A wallet *you* revoke loses its mediator connection 30 days later. After that the
  app can no longer receive messages, so call `reset()` and have its credentials issued again.
- Observe `OneTwoId.state` (`Uninitialized`, `Initializing`, `Ready`, `Failed(error)`).

## Everyday calls

| Call | What it does |
|---|---|
| `connect(invitationUrl)` | Accepts an organisation's invitation (the URL behind its QR code). Completion arrives as `WalletEvent.ConnectionCompleted` |
| `connections()` | Pairwise connections with organisations |
| `pendingOffers()` / `acceptOffer(id)` / `declineOffer(id)` | Credential offers wait for the user. After `acceptOffer` the credential is stored automatically when it arrives (`WalletEvent.CredentialStored`) |
| `credentials()` / `credential(id)` | Stored credentials with their attributes and `expiresAtEpochSeconds` |
| `pendingProofRequests()` / `proofRequestOptions(id)` / `respondToProofRequest(id, selection)` / `declineProofRequest(id)` | Proof requests wait for the user. `proofRequestOptions` lists, per requested group, the stored credentials that can answer it; `ProofRequestOptions.defaultSelection()` picks the first of each. `WalletEvent.ProofSent` follows |
| `expectMessages(timeout = 30.seconds)` | Tells the wallet an offer or proof request is on its way, so it collects it within a second or two. Call it when your app asks your backend to start an exchange (below). Returns at once |
| `sync()` / `awaitDelivery()` | `sync()` collects messages queued at the mediator now; call it from your push handler (below), or for pull-to-refresh. `awaitDelivery()` waits for the wallet's follow-up checks, at the end of a push worker |
| `reset()` | Deletes the wallet, its key and the SDK state. Credentials are gone for good; organisations re-issue them |
| `events` / `addListener` | `WalletEvent`s: `OfferReceived`, `CredentialStored`, `ProofRequested`, `ProofSent`, `ConnectionCompleted`, `ExchangeFailed` |

Every call throws an `OneTwoIdException` subtype: `NotInitialized`, `WalletTokenRejected`,
`NetworkUnavailable`, `PlatformError`, `InvalidInvitation`, `MediatorUnavailable`,
`LedgerUnavailable`, `NotFound`, `InvalidSelection`, `WalletKeyLost`, `Internal`.

## Delivery: when the wallet collects messages

Messages for the wallet wait at 12id's mediator until the wallet asks for them. The wallet does **not**
poll on a timer: every message comes from something your backend or the organisation started, so the
wallet asks exactly when something can be there.

| When | What the wallet does |
|---|---|
| After `connect`, `acceptOffer` and `expectMessages` | Asks every second, then every two seconds, until the expected reply arrives (at most 30 s; `expectMessages` up to 120 s) |
| When the app comes to the foreground | Collects whatever is queued, once |
| On `sync()` (your push handler) | Collects whatever is queued, then checks three more times over the next 32 s |
| Otherwise | Nothing. An open, idle app sends no requests |

So:

- **Your app starts the exchange** (sign-in → your backend offers a credential; a payment → your
  backend requests a proof): call `expectMessages()` when the app asks your backend. The offer or
  request appears within a second or two. See [the recipe](#recipe-issue-at-sign-in-prove-before-an-action).
- **The organisation starts it on its own** (an offer after a back-office approval, a request from a
  kiosk or website): it arrives with your push, whether the app is open or not, or else the next time
  the app comes to the foreground.

**Push.** To deliver messages the organisation starts on its own:

1. The platform sends your backend a signed `wallet.sync_requested` webhook (`data.walletId`,
   `data.externalId`; at most one per wallet per 30 s). It can arrive while the app is open: treat it
   as "sync now", not "a credential arrived".
2. Your backend sends a silent (data-only) push to that installation with your own FCM setup. A
   data-only message needs no notification permission.
3. Your push handler calls `sync()`, then `awaitDelivery()`, from WorkManager expedited work so it
   survives the handler. `sync()` returns once the queue is empty; the wallet then checks again over
   the next 32 s, because a message queued right after this push gets no push of its own (the 30 s
   limit above), and `awaitDelivery()` keeps the work alive for that:

```kotlin
class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        OneTwoId.initialize(applicationContext, MyApp.config)   // no-op when already open
        val result = OneTwoId.sync()                            // returns counts; drained=false on timeout
        OneTwoId.awaitDelivery()                                // the follow-up checks, at most ~32 s
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

**No push at all?** Messages the organisation starts on its own then arrive when the app next comes to
the foreground. If they must also appear while the app sits open, set
`OneTwoIdConfig(idlePollInterval = 30.seconds, …)` (at least 10 s): the wallet then also asks at that
interval while the app is in the foreground. It costs a request per interval for every open app, so
prefer push.

## Recipe: issue at sign-in, prove before an action

Everything runs without the user scanning a QR code or tapping "accept" in a 12id screen; your app
decides what to show.

**At sign-in** (once per installation):

1. Your backend creates the wallet (`POST /v1/wallets`, installation id as `Idempotency-Key`) and a
   connection invitation for this user (`POST /v1/connections/invitations` with `externalId` = your
   user id), and returns both the wallet token and the `invitationUrl` to the app.
2. The app connects and says an offer is coming:

   ```kotlin
   OneTwoId.connect(invitationUrl)
   OneTwoId.expectMessages(60.seconds)   // covers the connection, then your backend's offer
   ```

3. Your backend receives `connection.state_changed: completed` (with your `externalId`), stores the
   connection id for this user and installation, and calls `POST /v1/credentials/offer`.
4. The app receives `WalletEvent.OfferReceived`; show it, or accept it directly, with
   `acceptOffer(id)`. `WalletEvent.CredentialStored` follows, and your backend gets
   `credential.state_changed: done`.

On later sign-ins, skip the connect step: the wallet already holds the connection and the credential
(`credentials()`). A reinstall or a new phone is a new wallet: connect and issue again.

**Before an action** (e.g. a payment):

1. The app calls your backend's action endpoint and, at the same moment, `OneTwoId.expectMessages()`.
2. Your backend calls `POST /v1/proofs/request` with the user's stored connection id and a template.
3. The app receives `WalletEvent.ProofRequested`; answer with
   `respondToProofRequest(id, proofRequestOptions(id).defaultSelection())`, after a confirmation if
   you want the user to see what is shared.
4. Your backend receives `proof.state_changed: done` with `verified` and `disclosed` (or polls
   `GET /v1/proofs/{id}`) and allows the action.

```kotlin
OneTwoId.events.collect { event ->
    when (event) {
        is WalletEvent.OfferReceived -> OneTwoId.acceptOffer(event.offerId)
        is WalletEvent.ProofRequested -> {
            val selection = OneTwoId.proofRequestOptions(event.requestId).defaultSelection() ?: return@collect
            OneTwoId.respondToProofRequest(event.requestId, selection)
        }
        else -> Unit
    }
}
```

The proof request goes over the connection made at sign-in, so it can only be answered by that user's
wallet on that installation. If the organisation requires a face check, `verifyFace` comes first
(below) and shows a camera screen.

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
- **Credentials cannot be revoked**; they carry an `expiresOn` date (`YYYYMMDD`, UTC) that every
  verifier checks with a predicate, so a credential simply stops being accepted after that day. `Credential.expiresAtEpochSeconds` is the last second of it.
  `Credential.isExpired()` tells you when to prompt for renewal. Attribute values are strings; see the
  platform guide for the encoding rules.

## Biometric checks (face liveness + match)

Some organisations require a face check before they issue a credential or accept a proof: the user
proves they are live and match a reference photo the organisation holds. The SDK knows which offers and
requests need it; the camera screen comes from a **capture add-on** for the organisation's vendor.

**1. Add the add-on for your organisations' vendor** (one artifact per vendor, same version as the SDK):

```groovy
dependencies {
    implementation "com.12id:holder-sdk-android:0.2.0"
    implementation "com.12id:holder-sdk-android-biometrics-aws:0.2.0"   // AWS Rekognition Face Liveness
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
connecting (paste or scan a QR), offers, credentials and proof requests. Its debug build also has
adb-driven test hooks, which 12iD uses for its end-to-end tests; they are not part of the SDK.
