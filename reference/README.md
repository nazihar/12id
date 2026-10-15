# 12iD reference integration

A complete, small example of what an organisation builds to use 12iD: **a backend** and **an Android app**. It uses only what every customer gets: the platform API with an API key, signed webhooks, the console, and the published SDK.

- `backend/`: about 550 lines of TypeScript with no dependencies. Run it as it is, or read it and write the same five calls in your own language.
- `android/`: an app that holds the user's credential in the 12iD wallet SDK and approves actions with it.

Guides and the API reference: <https://docs.12id.com>.

## What it does

A bank's app, in two flows. Both start in the app.

**1. The user signs in and gets a card.**

```
app                         backend                          12iD
 │ POST /session             │                                │
 │ POST /wallet-token ──────▶│ POST /v1/wallets ─────────────▶│   one wallet per installation
 │ (the SDK opens the wallet with that token)                 │
 │ POST /enrol ─────────────▶│ POST /v1/connections/invitations
 │◀──────── invitationUrl ───│                                │
 │ connect(invitationUrl), expectMessages()  ────────────────▶│
 │                           │◀─ webhook connection completed ─│
 │                           │ POST /v1/credentials/offer ───▶│
 │◀──────────────────────────── the offer ────────────────────│
 │ acceptOffer()  → the card is stored on the phone            │
```

**2. The user sends money and approves it with the card.**

```
 │ POST /actions ───────────▶│ POST /v1/proofs/request ──────▶│
 │ expectMessages()          │                                │
 │◀──────────────────────────── the proof request ────────────│
 │ respondToProofRequest()  ─────────────────────────────────▶│   12iD checks the proof
 │                           │◀─ webhook proof done, verified ─│
 │ GET /actions/:id ────────▶│ "approved"                     │
```

No code is sent by SMS and nothing is typed: the phone proves it holds the card the bank issued, and reveals only what the request names.

## Where to look

| You want to see | File |
|---|---|
| The calls to the 12iD API | `backend/src/platform.ts` |
| Checking a webhook's signature, and what to do on each event | `backend/src/webhooks.ts` |
| The routes an app needs from its backend | `backend/src/server.ts` |
| What a backend must remember | `backend/src/store.ts` |
| Every SDK call the app makes | `android/app/src/main/java/com/onetwoid/reference/Wallet.kt` |
| The two flows, step by step | `android/app/src/main/java/com/onetwoid/reference/MainViewModel.kt` |
| Adding the SDK to an app | `android/settings.gradle`, `android/app/build.gradle` |

## Things worth copying

- **The app never holds an API key.** It asks its backend; the backend asks 12iD.
- **Everything is asynchronous.** A command returns at once; the result arrives as a webhook. Pass your own id as `externalId` and it comes back on every event (`webhooks.ts`).
- **Webhooks can arrive twice and out of order.** Every handler is safe to repeat, and every command that must not run twice carries an `Idempotency-Key`.
- **Tell the wallet when to look.** The wallet does not poll. When the app asks its backend for something that makes 12iD send a message, it calls `expectMessages()` at the same moment (`Wallet.kt`).
- **A refused request keeps its key.** 12iD remembers the answer to an `Idempotency-Key` for 24 hours, refusals (4xx) included, and the same key with a different body is refused too. Derive the key from what you send, so a corrected request gets a new one (`offerCredential` in `webhooks.ts`).
- **Check your settings against the catalogue at start.** An offer must carry exactly the schema's attributes; a mismatch is otherwise only visible as a card that never arrives (`tenant-check.ts`).
- **Keep the wallet token you were given.** `POST /v1/wallets` shows it once, so call it once per installation and keep the wallet id and token. When the SDK says the token was rejected, `POST /v1/wallets/{id}/token` issues a new one for the same wallet; only a revoked wallet is replaced by a new one (`walletToken()` in `server.ts`).
- **Keep the app's session out of backups, like the wallet.** The wallet cannot be restored (its key is in the phone's Keystore), so anything that names it must not be restored either: here the session token and the installation id (`res/xml/backup_rules.xml`, `data_extraction_rules.xml`). Otherwise a reinstalled app comes back signed in, with an empty wallet.
- **Trust `verified`, nothing else.** An action is approved only by a `proof.state_changed` event with `state: done` and `verified: true`.
- **Every wait ends.** A message may never arrive; the app gives up after a time and lets the user try again.

## With a face check

An organisation can require a face check before a card is issued or before a proof is accepted (console, **Biometrics**: per credential definition and per proof template). The user looks at the camera; 12iD checks that a live person is there and that the face matches the photo the organisation holds.

```
app                         backend                          12iD
 │ POST /photo (first sign-in) │  keeps the photo on file      │
 │ POST /enrol, connect …      │ POST /v1/credentials/offer    │
 │                             │   + biometric.referenceImage ▶│
 │◀──────────────────────────── the offer, "face check needed" │
 │ verifyFace()  → the camera screen → passed                  │
 │ acceptOffer() → the card is issued                          │
```

- **Backend:** set `"photoOnFile": true` in `tenant.json`. The backend then sends the user's photo as `biometric.referenceImage` with every offer and proof request (`faceReference` in `webhooks.ts`). 12iD uses it only where the policy requires a check and deletes it once the check is decided.
- **App:** add the face-check add-on next to the SDK and register it once (`build.gradle`, `Wallet.kt`). When an offer or a proof request says a check is needed, call `verifyFace` before accepting (`faceCheck` in `MainViewModel.kt`).
- **Nothing else changes.** The decision is made by 12iD from the provider's result, not by the app: an app that skips the check gets no card and no approval.
- A later sign-in does not issue again: the wallet already holds the card.

### Only for some requests (for example large transfers)

A proof template can require the face check only when a rule holds: console, **Proof templates**, the face-check button, "Require a face check when…", for example `amount ≥ 5000`. The rule lives in the console. The backend does not decide anything; it reports the facts with every request:

```json
"actions": { "transfer": { "proofTemplateId": "…", "faceCheckParams": ["amount"] } }
```

- `faceCheckParams` names the details of the action that the rule is decided from. The backend sends them as numbers in `biometric.params` (`startAction` in `server.ts`), together with the photo, for small and large amounts alike. 12iD applies the rule: a transfer of 1000 is approved without the camera, one of 5000 asks for the face check.
- The parameter names are yours. A rule can use several (`amount ≥ 5000` or `riskScore > 70`); send a yes/no fact as 1 or 0.
- 12iD refuses a request that lacks a number the rule names, so a mistake cannot quietly skip the check. The backend's start-up check (`npm run tenant`) says which names are missing from `faceCheckParams`.
- To change the threshold, change the rule in the console. Nothing is deployed.

## What is a stand-in

Replace these with your own:

- **Sign-in.** `POST /session` takes a name and a shared access code. Yours authenticates a real user.
- **The photo on file.** Where face checks are on, the app takes a photo at the first sign-in (`POST /photo`). You already hold one from your own customer onboarding.
- **The store.** One JSON file. Yours is your database.
- **Push.** The flows here start in the app, so none is needed. For messages you send on your own, your backend sends a push when it receives `wallet.sync_requested`, and the app calls the SDK's `sync()` (the SDK guide has the code).

## Run it for your own organisation

### 1. In the 12iD console

1. **Catalogue → Publish schema.** Name it (for example `member-card`, version `1.0`) with the attributes `fullName`, `memberId`, `level`, `birthDate`. The console adds `expiresOn`.
   - The app shows the attributes its skin names (`Skin.kt`); with other names it works, but the card shows them unlabelled or not at all.
   - Do not name an attribute `id`: some wallets cannot store such a credential, and a published schema cannot be changed.
2. **Catalogue → Credential definitions → Publish** for that schema.
3. **Proof templates → New.** One group that uses the schema; disclose `memberId`; add the predicate `level >= 1`. The template's name is what the user's phone shows.
4. **API keys → Create.** Copy the key; it is shown once.
5. **Webhooks → Set endpoint** to `https://<your backend>/webhooks/12id`. Copy the secret; it is shown once.

### 2. The backend

```bash
cd backend
cp env.example .env          # the API key, the webhook secret, an access code of your choice
npm run tenant               # prints your credential definition and template ids
cp tenant.example.json tenant.json   # and put those ids in it
docker compose up -d         # or: npm start  (Node 22.18 or newer; nothing to install)
```

It listens on `127.0.0.1:3700`. Put your HTTPS reverse proxy in front: the app and 12iD's webhooks both need https.

`tenant.json` holds everything tied to the organisation's catalogue:

```json
{
  "credentialDefinitionId": "…",
  "credential": { "validDays": 365, "attributes": { "fullName": "{name}", "memberId": "{memberId}", "level": "2", "birthDate": "19900101" } },
  "photoOnFile": false,
  "actions": { "transfer": { "proofTemplateId": "…" } }
}
```

- `photoOnFile`: `true` when the organisation uses face checks (see "With a face check").
- `actions.<name>.faceCheckParams` (optional): the details a conditional face-check rule is decided from, e.g. `["amount"]` (see "Only for some requests").
- One attribute per schema attribute, except `expiresOn`, which is computed from `validDays`.
- `{name}` and `{memberId}` come from the signed-in user; anything else is issued as written. A real backend takes every value from its own records.
- **To point the backend at another organisation:** replace `tenant.json`, `PLATFORM_API_KEY` and `WEBHOOK_SECRET`, then `docker compose up -d --force-recreate`.

### 3. The app

```bash
cd android
./gradlew :app:assembleDebug -PbackendUrl=https://<your backend> -PplatformApiUrl=https://api.12id.com
```

- The SDK version is one line in `android/gradle.properties` (now 0.2.2).
- How the app looks (name, colours, labels, the action's wording) is one entry in `Skin.kt`.

### Skins

At the first launch the app asks which skin to use and keeps the answer: from then on it always opens with that skin, and "Reset this app" keeps it. To choose again, clear the app's data or reinstall it. This way a client who is shown the demo never sees the other skins.

- **12iD reference** (`Skins.default`): the plain screens in `MainActivity.kt`.
- **MTB Neo** (`Skins.mtbNeo`): a copy of MTB's own app (`MtbNeo.kt`). The log-in screen takes the User ID as the name and the password as the access code. The first log-in issues the card (with the face check where the organisation uses it). **MTB Transfer** is approved with the card, and the log-out icon ends the session but keeps the card on the phone. The account number shown is the member ID. Controls outside the two flows say "Not part of this demo".

A new client is usually one more `Skin` entry with `SkinStyle.Standard`. A client's own look is a new `SkinStyle` and one file of screens. Both looks use the same `MainViewModel`, `Wallet.kt` and `Backend.kt`.

## Checks

```bash
cd backend && npm ci && npm run typecheck && npm test
cd android && ./gradlew :app:assembleDebug
```
