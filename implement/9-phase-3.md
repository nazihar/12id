# Phase 3 — Platform API (plan)

## Context

Phases 0–2 are done and on staging (`12id/implement/1…8`): signed genesis, von-network pool, endorser DID, two patched mediator replicas (`12id/mediator:375518d-p1`), TLS edge, monitoring, and — from Phase 2 — a multi-tenant Credo 0.7 `agent-service` plus `endorser-service` under `services/`, proven with the native Kotlin holder against a tenant issuer (`smoke:tenant-android` PASSED, incl. offline delivery and the expiry predicate).

What exists is *private*: agent-service's internal API (`services/agent-service/src/http/command-routes.ts`) has no auth, is reachable only over SSH, and its `outbox` table has no consumer. Customers cannot touch anything yet. Phase 3 builds **the product surface** (4-init §2.6, §10 Phase 3): a public, API-key-authenticated **platform-api** over agent-service, webhook delivery to customer backends, the wallet-onboarding endpoints the SDK needs (mediator invitation, ledger config), and the mediator-webhook → customer wake path.

**Decisions taken with the user (this session):**

| Item | Decision | Consequence |
|---|---|---|
| Push wake path (§4.8) | **Relay via customer webhook.** Platform maps the mediator webhook to a wallet and emits `wallet.sync_requested` to the customer backend; the customer pushes with their own FCM/APNs | No device-token registry, no FCM credentials on the platform. `POST /devices` is dropped from §10 |
| Per-user mediator invitations (§2.3) | **Patch the mediator** with an internal `POST /admin/invitations` route (second file in the `375518d` overlay → `-p2`) | Platform mints one single-use invitation per wallet; the mediator connection's `out_of_band_id` maps webhook `connectionId` → wallet with zero SDK involvement. `/admin/*` blocked at the edge like `/invite` |
| Wallet/SDK auth | **Per-wallet token** minted by the customer backend via `POST /v1/wallets` | SDK gets `walletToken` from the host app; revocable per wallet; platform never links wallets to end-user identities |
| Job queue | Postgres-only (`FOR UPDATE SKIP LOCKED` worker loop), no Redis/bullmq | Matches the codebase's existing patterns (outbox, mediator patch); one fewer service |
| Layout | `services/platform-api/` in the existing npm workspace, same image, own `compose.platform.yml` | Same toolchain rules: plain `node`, `tsc --noEmit`, `node --test`, Fastify + zod, drizzle |

**Verified while planning (staging DB, read-only):** the mediator's Drizzle `DidcommConnection` table has `out_of_band_id`, `thread_id` (= the Kotlin holder's connection-request id) and `their_did` (stored as `did:peer:1zQm…`, *not* the holder's plain DID). So `out_of_band_id` is the clean join key once invitations are per-wallet; `thread_id` is the fallback if the patch is ever dropped.

**Outputs:** this plan copied to `12id/implement/9-phase-3.md`; code in `services/platform-api/` (+ small agent-service additions); `infra/staging/compose.platform.yml`, Caddy site `api.<domain>`, mediator patch `-p2`; `infra/smoke/platform-credo.ts` and `platform-android.ts`; `12id/implement/10-phase-3-findings.md`; 4-init updates; published `openapi.json`.

---

## Architecture (Phase 3 additions)

```
customer backend ──API key──▶ platform-api ──internal token──▶ agent-service (commands)
                 ◀─signed webhooks─┘   │  ◀── poll GET /outbox ───┘
customer app/SDK ──wallet token──▶     │──internal token──▶ mediator POST /admin/invitations
mediator ──POST /internal/mediator/<secret>──▶ │──read-only SQL──▶ mediator drizzle DB (oob_id → wallet)
```

- **platform-api** is the only new long-running service. Public via Caddy at `api.12id.naziharitsolution.com`; joins `12id-agent` (agent-service, agent-postgres) and `12id-mediator` (webhook receiver target, drizzle read-only).
- **Own database** `platform_api` on the existing `agent-postgres` instance (separate DB, per 4-init §2.6).
- **State model:** platform tables are a denormalised mirror of agent-service records, fed by the outbox consumer; customer reads hit the platform DB, never the agent, except proof detail on first `done`.

---

## Workstreams

### P0 — agent-service additions (small, keep the D2 boundary)
Files: `services/agent-service/src/http/command-routes.ts`, `exchanges/exchanges.ts`, new `src/http/outbox-routes.ts`.
- `GET /outbox?afterId=<bigint>&limit=<n≤500>` → rows `id > afterId` ordered by id, **only rows with `created_at < now() - 2s`** (the listener inserts asynchronously, so a lower id can commit after a higher one was read). `POST /outbox/ack { upToId }` sets `delivered_at` (observability only; the consumer keeps its own cursor).
- `GET /tenants/:tenantId` (status, did) — onboarding today is `202` + background, with no read route.
- `GET /tenants/:tenantId/connections/:id`; `GET /tenants/:tenantId/credentials/:id` additionally returns `credentialDefinitionId` (unqualified) and the offered `attributes` from the record.
- Internal token on the agent internal API, reusing `INTERNAL_TOKEN_HEADER` + `tokenMatches` from `endorser-service/src/http/endorser-api.ts` (move `tokenMatches` into `credo-base/src/internal-token.ts`). `/healthz`, `/readyz` stay open. Config: `INTERNAL_TOKEN` (reuse `AGENT_INTERNAL_TOKEN` in compose).

### P1 — mediator patch `-p2`: `POST /admin/invitations`
Files: `infra/staging/mediator/Dockerfile.patched`, new `patch/agent.js` (built file from the image, `/app/apps/mediator/build/agent.js`, after the `/invite` route at line ~80).
- Route: requires header `x-admin-token` equal to `process.env.ADMIN_API_TOKEN` (constant-time compare; **route disabled when the env is unset**). Body `{ goalCode? }`. Calls `agent.didcomm.oob.createInvitation({ multiUseInvitation: false, goalCode: config.invitationGoalCode, goal: 'Mediator Invitation' })` (same options as `index.ts:24`), returns `{ outOfBandId, invitationUrl }` with `toUrl({ domain: config.invitationUrl })`.
- Compose: image `12id/mediator:375518d-p2`, `ADMIN_API_TOKEN` from `mediator.sops.env`; roll `mediator-1` then `-2`. Caddyfile: `@admin path /admin /admin/*` → 404 next to the `/invite` block.
- Record in findings: the OOB record has no expiry — "short-lived" is enforced by the platform handing it out once; an unused invitation stays valid on the mediator (bounded by rate limits + spike alert). Note the Kotlin holder's single-use behaviour (it should be identical to multi-use on first use; verify in P8).

### P2 — platform-api skeleton
`services/platform-api/` (`package.json` pinned to the same versions as agent-service; add `@fastify/swagger` for OpenAPI; `@fastify/rate-limit` optional).
```
src/config.ts            zod env (DATABASE_URL, AGENT_API_URL/TOKEN, MEDIATOR_ADMIN_URL/TOKEN,
                         MEDIATOR_DRIZZLE_URL (read-only role), MEDIATOR_WEBHOOK_SECRET, PLATFORM_ADMIN_TOKEN,
                         PUBLIC_URL, LEDGER_* for /v1/ledger, worker intervals)
src/db/schema.ts         tenants, api_keys, wallets, connections, credentials, proofs, proof_templates,
                         webhook_endpoints, webhook_deliveries, outbox_cursor, idempotency_keys
src/db/{client,migrate}.ts, drizzle/      same shape as agent-service (reuse credo-base/postgres-migrate.ts)
src/provision.ts         ensureDatabase + migrations (init job)
src/agent-client.ts      typed fetch client for agent-service internal API (token header, error mapping)
src/mediator-client.ts   admin invitations + drizzle read-only lookup (oob_id → connection id and back)
src/http/app.ts          Fastify + zod + internalApiErrorHandler (credo-base/fastify-errors.ts), swagger
src/http/auth.ts         API-key and wallet-token bearer auth (sha256 lookup, timingSafeEqual), admin token
src/http/routes/{admin,catalogue,connections,credentials,proof-templates,proofs,wallets,wallet,webhook,ledger,internal}.ts
src/outbox-consumer.ts   poll agent outbox → mirror tables → enqueue webhook events
src/webhooks/{signer,dispatcher}.ts   HMAC signing, SKIP LOCKED worker, backoff, dead-letter
src/main.ts              server + workers + SIGTERM (stop accepting, finish in-flight deliveries, close pool)
test/                    node --test
```
Shared error handling and response-schema stripping exactly as in `agent-service/src/http/internal-api.ts`.

### P3 — auth and tenancy
- **API keys**: `12id_sk_<32 bytes base64url>`; store `sha256`, `prefix` (first 12 chars for lookup), `label`, `revoked_at`, `last_used_at`. Plaintext returned once at creation. Auth plugin resolves `request.tenant`.
- **Wallet tokens**: same scheme, `12id_wt_…`, stored on `wallets` (`token_hash`, `revoked_at`).
- **Operator routes** (`/admin/*`, header `x-admin-token` = `PLATFORM_ADMIN_TOKEN`, blocked at the edge → only over SSH tunnel): `POST /admin/tenants {name}` → creates platform tenant, calls agent `POST /tenants` then `POST /tenants/:id/onboard` synchronously (534 ms on staging), stores `agent_tenant_id`, `did`; `GET /admin/tenants`; `POST /admin/tenants/:id/api-keys`, `DELETE /admin/api-keys/:id`. Phase 4's admin UI replaces the tunnel.
- **Idempotency**: optional `Idempotency-Key` header on every customer POST; `(tenant_id, key)` → stored status+body for 24 h; replay returns the stored response, mismatched body → 422.

### P4 — customer resources (`/v1`, API key)
All ids exposed to customers are the agent/Credo record ids (uuid), scoped by tenant on every query. Every command accepts `externalId` (≤200 chars) which becomes the agent-service `correlationId` and is echoed in every webhook and GET.
- **Catalogue**: `POST /v1/schemas` (name, version, attributes; `expiresAt` mandatory — agent enforces), `GET /v1/schemas`, `POST /v1/credential-definitions {schemaId, tag}`, `GET /v1/credential-definitions`, `POST /v1/schemas/:id/deprecation {deprecated}`. Views expose **both** identifier forms. Thin pass-through to the agent catalogue routes; mirror rows in `ledger_objects`-like table or read-through (read-through: the agent already stores it — **decision: read-through**, no mirror).
- **Connections**: `POST /v1/connections/invitations {multiUse=false, alias?, externalId?}` → `{ invitationId (oob id), invitationUrl, multiUse }`. `GET /v1/connections?invitationId=&state=`, `GET /v1/connections/:id` from the mirror table.
- **Credentials**: `POST /v1/credentials/offer {connectionId, credentialDefinitionId, attributes, externalId?}` → 202 `{ id, threadId, state }`; `GET /v1/credentials/:id`, `GET /v1/credentials?connectionId=`. States passed through verbatim from Credo (`offer-sent … credential-issued, done, abandoned`); document that `credential-issued` = delivered, `done` = acknowledged (Phase 2 finding).
- **Proof templates**: `POST/GET/PUT/DELETE /v1/proof-templates`. Shape: `{ name, groups: [{ key, attributes, credentials: [{ schemaName, versions?: 'all'|'active' } | { credentialDefinitionId }], predicates? }] }`. Expansion at request time resolves each entry to the **unqualified** cred def ids from the agent catalogue (`versions: 'all'` keeps deprecated definitions verifiable, §5.1). The `expiresAt` predicate is added by agent-service; the template validator refuses `expiresAt` in `attributes` (Phase 2 trap: an attribute cannot be revealed and predicated).
- **Proofs**: `POST /v1/proofs/request {connectionId, templateId | request, externalId?}` → 202; `GET /v1/proofs/:id` → `{ state, verified, disclosed, errorMessage }`; `GET /v1/proofs?connectionId=`.
- **Webhook config**: `PUT /v1/webhook {url (https only), events?}` → `{ secret }` returned once (regenerate via `POST /v1/webhook/rotate-secret`); `GET /v1/webhook`; `GET /v1/webhook/deliveries?status=failed|dead`, `POST /v1/webhook/deliveries/:id/retry`.

### P5 — wallet endpoints (SDK-facing)
- Customer: `POST /v1/wallets {externalId?}` → `{ walletId, walletToken }`; `GET /v1/wallets/:id`; `DELETE /v1/wallets/:id` (revokes token; mediator record untouched).
- Wallet token: `GET /v1/wallet/mediator-invitation` → mints via P1, stores `mediator_oob_id` on the wallet (one active per wallet; a second call replaces it), returns `{ invitationUrl }`. `GET /v1/wallet` → wallet status.
- Public: `GET /v1/ledger` → `{ indyNamespace, genesis: { url, sha256, signatureUrl, signingPublicKey }, vdrProxyUrl }` from config (the file itself stays on `genesis.<domain>/v1/…`, already versioned, immutable and minisign-signed — that closes the §10 "`GET /ledger/genesis`" item without a second copy).

### P6 — outbox consumer and mirror
`src/outbox-consumer.ts`, single worker, 1 s poll (configurable), cursor in `outbox_cursor` (one row). Per row: map `tenant_id` (agent) → platform tenant; upsert `connections` / `credentials` / `proofs` by `(tenant_id, record_id)` with `state`, `thread_id`, `correlation_id`, payload fields; ignore rows whose state is older than the stored state; on `proof` reaching `done`/`abandoned` call agent `GET /proofs/:id` once and store `verified` + `disclosed`; then insert a `webhook_deliveries` row. Processing is idempotent (at-least-once); cursor advances after the batch commits. Reuse the mapping test style of `agent-service/test/outbox-listener.test.ts`.

### P7 — webhook dispatcher and the wake path
- **Envelope**: `{ id, type, createdAt, tenantId, data }`; types `connection.state_changed`, `credential.state_changed`, `proof.state_changed`, `wallet.sync_requested`. Headers `X-12id-Event`, `X-12id-Delivery`, `X-12id-Signature: t=<unix>,v1=<hmac-sha256(secret, "<t>.<body>")>`; 10 s timeout; 2xx = delivered.
- **Worker**: `SELECT … FOR UPDATE SKIP LOCKED WHERE next_attempt_at <= now()`; backoff `min(2^n × 5 s, 1 h)` with jitter; 12 attempts → `dead` (customer sees it in `GET /v1/webhook/deliveries`, can retry). Per-tenant ordering is *not* guaranteed (document; consumers should use `state` + `updatedAt`).
- **Mediator receiver**: `POST /internal/mediator/:secret` (`MEDIATOR_WEBHOOK_SECRET`, path constant-time compared; edge returns 404 for `/internal/*`). Body `{ connectionId }` (no `fcmToken` — Phase 1 finding). Lookup `SELECT out_of_band_id FROM "DidcommConnection" WHERE id = $1` on the drizzle DB with a **read-only role** → `wallets.mediator_oob_id` → tenant. Cache `connection_id → wallet_id` on the wallet row (`mediator_connection_id`) after first hit. **Debounce**: at most one `wallet.sync_requested` per wallet per `WAKE_DEBOUNCE_MS` (default 30 s, since the mediator fires one webhook per queued message even while the app is polling). Unknown connection → 204 + counter (pre-Phase-3 wallets, smoke leftovers). Always answer 2xx fast; the mediator logs failures but never retries.
- Mediator compose: `PUSH_NOTIFICATIONS__WEBHOOK_URL=http://platform-api:3500/internal/mediator/${MEDIATOR_WEBHOOK_SECRET}`; keep `webhook-sink` only as an optional debugging override.

### P8 — OpenAPI + docs
`@fastify/swagger` with `jsonSchemaTransform` from `fastify-type-provider-zod`; `GET /openapi.json` public; `npm run openapi` writes `services/platform-api/openapi.json` (committed, the customer artefact). `docs/api.md`: auth, async model (commands return 202, progress by webhook or polling), state glossary, attribute-encoding rules (§5.2), no-revocation/expiry story (§4.7, §5.3), webhook signature verification snippet, wallet onboarding sequence for the SDK integrator.

### P9 — staging deploy
- `infra/staging/compose.platform.yml`: `platform-provision` (init job) + `platform-api` (`127.0.0.1:3500`, networks `default`=`12id-platform`, `agent` external `12id-agent`, `mediator` external `12id-mediator`; `mem_limit 512m`; `stop_grace_period 30s`); `secrets/platform.sops.env` (`PLATFORM_ADMIN_TOKEN`, `MEDIATOR_WEBHOOK_SECRET`, drizzle read-only password; `AGENT_INTERNAL_TOKEN` and `MEDIATOR_ADMIN_TOKEN` via `EXTRA_SECRETS="agent mediator"`).
- One-time SQL (runbook `infra/runbooks/platform-api.md`): `CREATE ROLE platform_ro … GRANT SELECT ON "DidcommConnection"` in the mediator's `drizzle` DB.
- `services/Dockerfile`: add `platform-api` manifest/src/drizzle copies. Image tag `12id/services:phase3` for all three services.
- Caddy `api.12id.naziharitsolution.com`: `hardening`, `per_ip_limit api_per_ip 600`, 404 for `/internal/*` and `/admin/*`, `reverse_proxy 127.0.0.1:3500`. Mediator site: add the `/admin/*` 404.
- `backup-postgres.sh`: add `platform_api`; run one restore drill. Monitoring: blackbox probe `https://api…/v1/ledger`; alert on `webhook_deliveries` dead-letter growth (postgres-exporter query) and on the outbox cursor lag.
- Roll the mediator to `-p2` (`mediator-1`, wait healthy, `mediator-2`).

### P10 — smoke tests and the Android run
- `infra/smoke/platform-credo.ts` (workstation, Credo holder behind the staging mediator as in `tenant-credo.ts`): operator bootstrap over the SSH tunnel (tenant + API key), then **everything else through `https://api.<domain>` with the API key**: schema → cred def → wallet → wallet mediator invitation (holder uses it instead of the log-scraped one) → connection invitation → offer → template → proof; a local webhook receiver reached via the existing `-R 3200:127.0.0.1:3201` tunnel (`smoke-issuer.<domain>` → workstation) asserts: every state event arrived, signatures verify, `wallet.sync_requested` fired at least once and at most once per 30 s, proof event carries `verified: true` and `disclosed`.
- `infra/smoke/platform-android.ts`: `tenant-android.ts` with the agent API swapped for the platform API and the app's mediator invitation taken from `GET /v1/wallet/mediator-invitation` (single-use). Live, offline (force-stop) and proof all DONE via webhooks; the mediator webhook → `wallet.sync_requested` observed during the offline step.
- `smoke:platform-android` on the phone is the Phase 3 gate.

---

## Verification
- `tsc --noEmit` and `node --test` green in `platform-api` and `agent-service`: API-key/wallet-token hashing and lookup, admin token, idempotency replay/mismatch, template expansion (deprecated versions, `expiresAt` refusal), outbox → mirror mapping and out-of-order states, webhook signature + backoff schedule + dead-letter, mediator receiver lookup/debounce/unknown-connection, response schemas strip unknown fields, generic 500 bodies (no SQL leak — regression from Phase 2).
- Local integration (Docker Postgres + staging ledger/mediator, as Phase 2 spikes): `platform-credo.ts` PASSED.
- Staging: `compose ps` healthy; from outside `GET https://api…/v1/ledger` 200, `/openapi.json` 200, `/internal/*` and `/admin/*` 404, unauthenticated `/v1/connections` 401, 3500 closed; mediator `/admin/invitations` 404 from outside and 200 from platform-api; `smoke:platform-android` PASSED with webhook evidence; SIGTERM drain leaves no in-flight delivery half-done; restore drill opens `platform_api`.
- Findings recorded in `12id/implement/10-phase-3-findings.md` with log excerpts, in the tier vocabulary of 4-init §0.1.

## Document updates this produces
- `12id/implement/9-phase-3.md` (this plan) and `10-phase-3-findings.md`.
- 4-init: §10 Phase 3 ticked/amended (no `POST /devices`; wake path via customer webhook; per-wallet invitations); §2.3 open-mediation mitigations → built; §2.6 responsibilities as built; §3 matrix rows for platform-api; §4.3/§4.8 rewritten around wallet tokens + `wallet.sync_requested`; §12.8 amended to `-p2`; new §12.12 (push relay decision) and §12.13 (wallet auth); traps: mediator webhook per message → debounce, outbox id ordering lag.
- Phase 5 SDK plan inputs: `initialize({ walletToken, apiBaseUrl })`, `sync()` on customer push, invitation fetched from `/v1/wallet/mediator-invitation`.

## Out of scope for Phase 3
Admin UI (Phase 4); platform-sent FCM/APNs (revisit if a customer cannot relay pushes); short invitation URLs / QR image rendering (return the OOB URL; optional `GET /v1/i/:id` redirect only if the Kotlin parser follows redirects — check in Phase 5); per-API-key rate limits beyond the edge per-IP limit; multi-region/HA of platform-api (single replica, like agent-service); Swift pass; production ledger (§12.1).
