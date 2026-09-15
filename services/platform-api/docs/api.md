# 12id Platform API — integration guide

Base URL (staging): `https://api.12id.naziharitsolution.com`. Machine-readable spec: `GET /openapi.json` (also committed as `openapi.json`).

## Credentials

| Caller | Header | Obtained from |
|---|---|---|
| Your backend | `Authorization: Bearer 12id_sk_…` | 12id operations (one or more keys per organisation) |
| Your app (the SDK) | `Authorization: Bearer 12id_wt_…` | your backend, via `POST /v1/wallets` |

Never ship an API key in an app. The wallet token is per installation and can be revoked with `DELETE /v1/wallets/{id}`.

## The asynchronous model

Every command returns immediately (`202`) with the exchange record. The holder answers minutes or hours later, so progress arrives by webhook (recommended) or by polling `GET` routes. Pass `externalId` on commands to get your own reference back on every event. Send an `Idempotency-Key` header on POSTs you may retry; a replay with the same key and body returns the original response (`Idempotent-Replayed: true`), the same key with a different body answers 422, and a retry that arrives while the first request is still running answers 409 `idempotency_in_progress` (retry after `Retry-After` seconds). A request that failed with a 5xx can be retried with the same key and runs again. Keys are kept for 24 hours.

Responses that carry a secret are never stored for replays:
- `POST /v1/wallets`: use your app's **installation id** (a UUID the app creates once and keeps) as the key. A retry returns the same wallet with a **new** `walletToken`; earlier tokens for that wallet stop working, so hand the app the most recent one. Each device or reinstall has its own installation id, so a user can have several wallets (share your user id through `externalId`).
- `POST /v1/webhook/rotate-secret` ignores the header: a retry rotates again and returns the newest secret.

| Exchange | States you will see |
|---|---|
| connection | `request-received` → `response-sent` → `completed` |
| credential | `offer-sent` → `request-received` → `credential-issued` (holder has it) → `done` (holder acknowledged); `abandoned` if the holder never answers (24 h) |
| proof | `request-sent` → `presentation-received` → `done` (`verified` + `disclosed` set); `abandoned` |

## Typical flow

1. `POST /v1/schemas` → `POST /v1/credential-definitions` (once per credential type/version).
2. `POST /v1/wallets` for each app installation; hand `walletToken` to the app.
3. App/SDK: `GET /v1/ledger` (genesis URL + sha256 + signature), `GET /v1/wallet/mediator-invitation` (once, at first launch). The Android SDK does both itself; see `sdk-android/docs/integration.md`.
4. `POST /v1/connections/invitations` → show `invitationUrl` as a link or QR code → `connection.state_changed: completed`.
5. `POST /v1/credentials/offer` → `credential.state_changed`.
6. `POST /v1/proof-templates` once; `POST /v1/proofs/request` → `proof.state_changed: done` with `verified` and `disclosed`.

## Attribute rules

- Values are strings. No nested objects, arrays, numbers or dates — encode dates as ISO strings or epoch seconds.
- Predicates (`>=`, `>`, `<=`, `<`) work only on attributes whose values are integers.
- Every schema must contain `expiresAt` (epoch seconds). **Credentials cannot be revoked in v1**; every proof request automatically checks `expiresAt >= now`, so expiry is how a credential stops being accepted. `expiresAt` can therefore never be disclosed.
- A schema cannot change. Adding a field means a new version; deprecate the old one to stop new offers while templates referencing the schema by name keep accepting both.

## Webhooks

`PUT /v1/webhook { url, events? }` (https only) returns `secret` once. Each event is POSTed as:

```json
{ "id": "…", "type": "proof.state_changed", "createdAt": "…", "tenantId": "…", "data": { "id": "…", "state": "done", "previousState": "presentation-received", "externalId": "…", "verified": true, "disclosed": { "employee": { "name": "…" } } } }
```

Verify `X-12id-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`, and reject old timestamps:

```js
const [t, v1] = header.split(',').map((p) => p.split('=')[1])
const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) && Math.abs(Date.now() / 1000 - Number(t)) < 300
```

Answer 2xx within 10 s. Failures are retried with exponential backoff (5 s doubling, capped at 1 h, 12 attempts) and then dead-lettered; see `GET /v1/webhook/deliveries?status=dead` and retry with `POST /v1/webhook/deliveries/{id}/retry`. Delivery order is not guaranteed — use `state` and `updatedAt`.

### `wallet.sync_requested`

Sent when the mediator is holding messages for one of your wallets (`data.walletId`, `data.externalId`). Send a silent push to that installation with your own FCM/APNs setup; the app calls the SDK's `sync()`. At most one per wallet every 30 s. It may also arrive while the app is open, or right after first launch — treat it as "sync now", not as "a credential arrived".

## Data protection

No personal data is written to the ledger. The platform stores exchange state and disclosed attributes for your tenant; credentials themselves live only on the holder's device. The mediator sees encrypted messages and their timing only.
