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
- **Keep the wallet token you were given.** `POST /v1/wallets` shows it once. Asking again with the same `Idempotency-Key` returns the same wallet with a new token for 24 hours; after that it creates another wallet (`walletToken()` in `server.ts`).
- **Trust `verified`, nothing else.** An action is approved only by a `proof.state_changed` event with `state: done` and `verified: true`.
- **Every wait ends.** A message may never arrive; the app gives up after a time and lets the user try again.

## What is a stand-in

Replace these with your own:

- **Sign-in.** `POST /session` takes a name and a shared access code. Yours authenticates a real user.
- **The store.** One JSON file. Yours is your database.
- **Push.** The flows here start in the app, so none is needed. For messages you send on your own, your backend sends a push when it receives `wallet.sync_requested`, and the app calls the SDK's `sync()` (the SDK guide has the code).

## Run it for your own organisation

### 1. In the 12iD console

1. **Catalogue → Publish schema.** Name it (for example `member-card`, version `1.0`) with the attributes `fullName`, `memberId`, `level`, `birthDate`. The console adds `expiresOn`.
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
  "actions": { "transfer": { "proofTemplateId": "…" } }
}
```

- One attribute per schema attribute, except `expiresOn`, which is computed from `validDays`.
- `{name}` and `{memberId}` come from the signed-in user; anything else is issued as written. A real backend takes every value from its own records.
- **To point the backend at another organisation:** replace `tenant.json`, `PLATFORM_API_KEY` and `WEBHOOK_SECRET`, then `docker compose up -d --force-recreate`.

### 3. The app

```bash
cd android
./gradlew :app:assembleDebug -PbackendUrl=https://<your backend> -PplatformApiUrl=https://api.12id.com
```

- The SDK version is one line in `android/gradle.properties`.
- How the app looks (name, colours, labels, the action's wording) is one entry in `Skin.kt`.

## Checks

```bash
cd backend && npm ci && npm run typecheck && npm test
cd android && ./gradlew :app:assembleDebug
```
