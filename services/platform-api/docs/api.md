# 12id Platform API — integration guide

Base URL: `https://api.12id.com` (production, from go-live); `https://api.12id.naziharitsolution.com` (staging). Machine-readable spec: `GET /openapi.json` (also committed as `openapi.json`).

## Credentials

| Caller | Header | Obtained from |
|---|---|---|
| Your backend | `Authorization: Bearer 12id_sk_…` | 12id operations (one or more keys per organisation) |
| Your app (the SDK) | `Authorization: Bearer 12id_wt_…` | your backend, via `POST /v1/wallets` |

Never ship an API key in an app. The wallet token is per installation and can be revoked with `DELETE /v1/wallets/{id}`.

**What an API key can do.** An API key runs your integration: connections, credential offers, proof requests and wallets, plus reading everything (catalogue, templates, webhook endpoint and deliveries). **Setup is done in the 12id console, not with an API key:**
- publishing schemas and credential definitions, and deprecating schemas;
- creating, editing and deleting proof templates;
- setting biometric policies;
- setting or removing the webhook endpoint, rotating its secret, and retrying deliveries.

With an API key, those routes answer `403 forbidden`. A leaked key therefore cannot write to the ledger or redirect your webhooks.

## The asynchronous model

Every command returns immediately (`202`) with the exchange record. The holder answers minutes or hours later, so progress arrives by webhook (recommended) or by polling `GET` routes. Pass `externalId` on commands to get your own reference back on every event. Send an `Idempotency-Key` header on POSTs you may retry; a replay with the same key and body returns the original response (`Idempotent-Replayed: true`), the same key with a different body answers 422, and a retry that arrives while the first request is still running answers 409 `idempotency_in_progress` (retry after `Retry-After` seconds). A request that failed with a 5xx can be retried with the same key and runs again. Keys are kept for 24 hours.

**Lists.** Every list route (`GET /v1/connections`, `/v1/credentials`, `/v1/proofs`, `/v1/wallets`, `/v1/webhook/deliveries`, `/v1/proof-templates`, `/v1/schemas`, `/v1/credential-definitions`) answers `{ "items": [...], "total": 312, "page": 1, "pageSize": 25 }`, newest first (`createdAt` descending); the order cannot be changed.
- `page` starts at 1, and `pageSize` is 25, 50 or 100 (default 25). A page past the end has an empty `items`.
- `q` is a case-insensitive contains search; on exchanges, `externalId` is the same match on your reference only (`?externalId=4711` finds `order-4711-b`).
- Exchanges also filter by `state` (repeat it for several: `?state=done&state=abandoned`). Exchanges, wallets and deliveries filter by creation time with `from` (inclusive) and `to` (exclusive), both ISO 8601.
- `total` counts every match, so `ceil(total / pageSize)` is the last page. To walk everything, raise `page` until `items` is empty.

**Rate limits.** Each API key may make 300 requests per minute, unless 12id raised the limit for your organisation. Each wallet token (the SDK) may make 60 requests per minute, and 3 mediator invitations per 10 minutes. Above a limit the API answers `429 rate_limited` with a `Retry-After` header (seconds). Wait that long, then retry.

**Wallet lifecycle.**
- `DELETE /v1/wallets/{id}` revokes the wallet token at once: the app gets 401. Thirty days later 12id also removes the wallet's mediator connection, so the installation can no longer receive messages. The app must call the SDK's `reset()`, and you issue its credentials again.
- A wallet that never connected to the mediator within 7 days of creation is revoked by 12id. For example, the app never started, or was uninstalled during onboarding. `GET /v1/wallets/{id}` then shows `revokedReason: "never_connected"`. Nothing had reached it, so nothing is lost.
- If that app starts later, your backend's `POST /v1/wallets` retry with the same installation id answers **409 `wallet_revoked`** during the first 24 hours after the original call. Create a new wallet with a new `Idempotency-Key` (for example the installation id plus a suffix). After 24 hours the same call simply creates a new wallet.
- `connectedAt` shows when 12id first saw the wallet's mediator connection.

Responses that carry a secret are never stored for replays:
- `POST /v1/wallets`: use your app's **installation id** (a UUID the app creates once and keeps) as the key. A retry returns the same wallet with a **new** `walletToken`; earlier tokens for that wallet stop working, so hand the app the most recent one. Each device or reinstall has its own installation id, so a user can have several wallets (share your user id through `externalId`).

| Exchange | States you will see |
|---|---|
| connection | `request-received` → `response-sent` → `completed` |
| credential | `offer-sent` → `request-received` → `credential-issued` (holder has it) → `done` (holder acknowledged); `abandoned` if the holder never answers (24 h) |
| proof | `request-sent` → `presentation-received` → `done` (`verified` + `disclosed` set); `abandoned` |

## Typical flow

1. In the console: publish the schema and its credential definition (once per credential type/version), set the webhook endpoint, and create proof templates. Your backend reads the result with `GET /v1/credential-definitions` and `GET /v1/proof-templates`.
2. `POST /v1/wallets` for each app installation; hand `walletToken` to the app.
3. App/SDK: `GET /v1/ledger` (genesis URL + sha256 + signature; cacheable for 5 minutes), `GET /v1/wallet/mediator-invitation` (once, at first launch). The Android SDK does both itself; see `sdk-android/docs/integration.md`.
4. `POST /v1/connections/invitations` → show `invitationUrl` as a link or QR code → `connection.state_changed: completed`.
5. `POST /v1/credentials/offer` → `credential.state_changed`.
6. `POST /v1/proofs/request` with a template id → `proof.state_changed: done` with `verified` and `disclosed`.

## Attribute rules

The full guide, with encoding recipes for dates, amounts and yes/no values, validity periods and wallet recovery: [`credential-model.md`](credential-model.md).


- Values are strings. No nested objects, arrays, numbers or dates — encode dates as ISO strings or epoch seconds.
- Predicates (`>=`, `>`, `<=`, `<`) work only on attributes whose values are integers.
- Predicates compare whole numbers from `-2147483648` to `2147483647` only; any other value is hashed and can be disclosed but not compared.
- Every schema must contain `expiresAt` (epoch seconds, at most `2147483647`, i.e. 2038-01-19; later values are refused because the expiry predicate could never be checked). **Credentials cannot be revoked in v1**; every proof request automatically checks `expiresAt >= now`, so expiry is how a credential stops being accepted. `expiresAt` can therefore never be disclosed.
- A schema cannot change. Adding a field means a new version; deprecate the old one to stop new offers while templates referencing the schema by name keep accepting both.
- Size limits on an offer: at most 125 attributes, names up to 100 characters, each value up to 4 KB, and 64 KB for all names and values together (400 otherwise). Credentials are meant for claims, not documents; store a document elsewhere and put its hash or reference in an attribute.
## Webhooks

Set the endpoint in the console (https only). The signing secret is shown once, when the endpoint is created or the secret is rotated. `GET /v1/webhook` returns the current URL and event filter. Each event is POSTed as:

```json
{ "id": "…", "type": "proof.state_changed", "createdAt": "…", "tenantId": "…", "data": { "id": "…", "state": "done", "previousState": "presentation-received", "externalId": "…", "verified": true, "disclosed": { "employee": { "name": "…" } } } }
```

Verify `X-12id-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` where each `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`, and reject old timestamps. **Accept the event if any `v1` matches.** For 24 hours after a secret rotation, every delivery carries two signatures, the new secret's first and the previous secret's second. That way your receiver keeps working while you switch it to the new secret.

```js
const parts = header.split(',').map((p) => p.split('='))
const t = parts.find(([k]) => k === 't')?.[1]
const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'))
const ok = Math.abs(Date.now() / 1000 - Number(t)) < 300 &&
  parts.some(([k, v]) => k === 'v1' && v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), expected))
```

Answer 2xx within 10 s. Failures are retried with exponential backoff (5 s doubling, capped at 1 h) for 12 attempts, **about 2.5 hours in total**, and then dead-lettered. See `GET /v1/webhook/deliveries?status=dead`, and retry dead deliveries from the console. Every attempt, retries included, goes to the endpoint URL set at that moment. Deliveries for different organisations are sent in parallel, so a slow receiver only delays its own events. Delivery order is not guaranteed: use `state` and `updatedAt`.

### `wallet.sync_requested`

Sent when the mediator is holding messages for one of your wallets (`data.walletId`, `data.externalId`). Send a silent push to that installation with your own FCM/APNs setup; the app calls the SDK's `sync()`. At most one per wallet every 30 s; the SDK checks again for 32 s after each `sync()`, so a message queued inside those 30 s is still collected. It may also arrive while the app is open, even for a message the app has already collected: treat it as "sync now", not as "a credential arrived".

The wallet does not poll on a timer. A message you send because the app asked for something (sign-in, an action) arrives within a second or two when the app calls the SDK's `expectMessages()` as it asks; a message you send on your own arrives with this push, or when the app next comes to the foreground. The Android guide has the full recipe ("Issue at sign-in, prove before an action"): your backend creates the wallet and an invitation at sign-in, stores the connection id from `connection.state_changed: completed` against the user, offers the credential on that connection, and later sends proof requests on the same connection.

## Biometric checks

Optional per tenant: before a credential is issued or a proof result is released, the holder passes a face **liveness** check and a **face match** against a reference image you provide. You configure your own vendor account (AWS Rekognition Face Liveness) in the console, switch the gate on, and choose where it applies:

- **Default** for the organisation (console → Biometrics).
- **Per credential definition** (console): `inherit`, `off` or `required`, with `minMatchScore`, `minLivenessScore` and `maxAttempts`. Scores are 0–100. Read it with `GET /v1/credential-definitions/{id}/biometric-policy`.
- **Per proof template** (console). Read it with `GET /v1/proof-templates/{id}/biometric-policy`.

When a policy applies, send the reference image with the command:

```json
POST /v1/credentials/offer
{ "connectionId": "…", "credentialDefinitionId": "…", "attributes": { … }, "biometric": { "referenceImage": "<base64 JPEG or PNG, ≤ 5 MB, one face>" } }
```

Without it the call answers **422 `biometric_reference_required`**. The image is used for this exchange only and deleted as soon as the check is decided (or expires); it is never returned, logged or sent in a webhook.

What happens next:

- The holder's app runs the check (the SDK's `verifyFace`). Each attempt sends a **`biometric.check_completed`** webhook with the scores and the decision.
- **Credentials** are issued only after a pass. If the holder accepts first, the exchange waits at `request-received`.
- **Proofs**: `verified` and `disclosed` stay `null` until the check passes, even when the presentation has already arrived.
- After the last failed attempt, or when the check expires (30 min by default), the exchange is **abandoned**; offer again if appropriate.
- `GET /v1/credentials/{id}` and `/v1/proofs/{id}` include `biometric` (status, attempts left, last scores); `GET /v1/credentials/{id}/biometric-log` (and `/v1/proofs/{id}/biometric-log`) returns every step with the vendor session id, for audit.

You are the controller of the reference images and must have the user's consent for the check.

### `record.erased`

Sent after an exchange's or a connection's personal data was erased on request (`data.recordType`, `data.recordId`, `data.erasedAt`, `data.initiator`: `api_key`, `tenant_member` or `operator`). Delete your own copies of that record's data. Erasure by the retention period sends no event.

## Data protection

No personal data is written to the ledger. Credentials live only on the holder's device. The mediator sees encrypted messages and their timing only. The platform keeps exchange state and, for the **retention period** (90 days by default, set in the console), the attribute values, disclosed values and webhook bodies; then it erases them automatically. `GET /v1/data-retention` returns the period in force.

To erase on a user's request:
- `POST /v1/credentials/{id}/erase` or `POST /v1/proofs/{id}/erase` for one finished exchange (409 while it is still running);
- `POST /v1/connections/{id}/erase` for a person's whole relationship with you: the connection and every exchange on it.

The record stays, with `erasedAt` set and its personal data `null`. `GET /v1/erasures` lists every erasure made on request. Erasing does not invalidate an issued credential: it stays usable until its `expiresAt`.

The full description, for your privacy and legal teams: [`data-protection.md`](data-protection.md).
