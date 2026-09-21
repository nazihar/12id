# Pre-production review — security gaps and optimization opportunities

**Phase:** this review's fix set is **Phase 7 — Pre-production hardening** (renumbered 2026-09-21 when the biometric gate became Phase 6, [`16-phase-6-biometric.md`](16-phase-6-biometric.md); this file was `15-phase-6.md`). The former Hardening is **Phase 8**.
**Status:** review only, 2026-09-16. Nothing was changed on staging or in the code. Every finding names its file and line; a finding marked *run* has its command and output in this file, *source read* was verified in the code, *reasoned* was not exercised.
**Scope:** platform-api, agent-service, endorser-service, credo-base, console, Android SDK, staging infra. The bucket-B follow-ups from the former `15-next-step.md` (its Phase 5b recommendation is carried in Appendix A below; the file itself was removed) are re-confirmed and ranked here (marked **B**).
**Baseline runs (all green):** platform-api 36/36 (against the local Phase 2 Postgres), agent-service 43/43, endorser-service 30/30, credo-base 10/10, console Vitest 11/11 + `tsc`, SDK JVM 30/30 + `apiCheck`; `tsc --noEmit` clean in all four services. `npm audit --omit=dev`: 10 / 4 / 9 moderate, all transitive (§7).

Severity is exploitability × impact against the **production** threat model (customer API keys, wallet tokens, endorser key, console token, mediator relay), not staging convenience.

---

## 1. Summary

| ID | Sev | Component | Finding | Effort |
|---|---|---|---|---|
| H1 | High | platform-api, agent-service | Personal data is retained forever in five places and there is no deletion path; §5.3 promises one | 2–3 d |
| H2 | High | infra | One shared internal token and a shared Docker network let platform-api call endorser-service directly (undoes §12.10) | 0.5 d |
| H3 | High | infra | Every service is a Postgres superuser; the endorser store lives in the internet-facing mediator's Postgres with its password | 1 d |
| M1 | Med | agent-service, edge | Public DIDComm endpoint accepts 5 MB junk, processed serially for all tenants → cheap cross-tenant DoS | 0.5 d |
| M2 | Med | platform-api | Webhook dispatcher is sequential: one slow customer stalls every tenant's webhooks (up to 200 s per tick) | 0.5 d |
| M3 | Med | platform-api, endorser | Any API key can publish unlimited immutable ledger objects; no quota, no approval | 1 d |
| M4 | Med | platform-api, edge | **B** No per-API-key / per-wallet rate limit; `GET /v1/wallet/mediator-invitation` mints an unexpiring mediator record per call | 1 d |
| M5 | Med | agent-service | **B** Trap 44 root cause: internal API `connectionTimeout: 10_000` destroys the socket during long handlers (cred-def publish) → 502 `agent_unreachable` | 2 h |
| M6 | Med | platform-api | Outbox consumer: a crash between the mirror upsert and the webhook enqueue loses that event for good | 0.5 d |
| M7 | Med | agent-service | Outbox settle window: an insert committing > 2 s after its id is allocated is skipped forever | 0.5 d |
| M8 | Med | platform-api | Delivery rows snapshot the webhook URL: retries keep posting to a URL the customer replaced or removed, up to a day | 2 h |
| M9 | Med | platform-api | Webhook secret rotation has no overlap; in-flight and retried deliveries fail the customer's check | 0.5 d |
| M10 | Med | platform-api, mediator | **B** Orphaned wallets, revoked wallets that stay mediated, and dead-holder queue rows have no sweep | 1 d |
| M11 | Med | infra | Secrets are container env vars: readable via `docker inspect`, `/proc/<pid>/environ`, crash dumps | 0.5 d |
| M12 | Med | console | CSP is only `frame-ancestors 'none'`; no `script-src`/`default-src` | 0.5 d |
| M13 | Med | infra | Backups are VM-local, encrypted to the only age key, which lives on the same VM | owner + 0.5 d |
| M14 | Med | SDK | Framework DEBUG lines (proof-request JSON, connection records) are forwarded to the host app's `LogSink` with no level floor; `apiBaseUrl` accepts `http://` | 2 h |
| M15 | Med | SDK | **B** Genesis authenticity on device rests on a sha256 from the same platform response (minisign published, not verified) | 1 d |
| M16 | Med | infra | No alerts for webhook dead-letters, outbox lag, endorser refusals, API 5xx rate, mediator OOB growth; alert e-mail unconfigured | 0.5 d |
| M17 | Med | infra | Mutable image tags (`phase3`, `phase4`, `postgres:15-alpine`, `valkey:8-alpine`); agent and platform stacks run different builds of one source tree; no CI | 1–2 d (5b.3) |
| M18 | Med | mediator | Credo `drizzle-storage` 0.6.0 creates **no secondary indexes**: every inbound message (each wallet's 10 s poll) sequentially scans `Did` and `DidcommConnection`; the pickup queue's `recipient_dids` branch is unindexed too — the mediator's scaling cliff | 0.5 d |
| L1 | Low | edge | `X-Powered-By: Express` on agent + mediator; HSTS without `includeSubDomains`/`preload`; `Server: Caddy` on genesis 404s | 1 h |
| L2 | Low | edge | Grafana and the von-network browser are public login/info surfaces | 1 h |
| L3 | Low | platform-api | List routes cap at 200 with no cursor; no `(tenant_id, created_at)` index on the three mirror tables | 0.5 d |
| L4 | Low | platform-api | Offer `attributes` unbounded in count/key/value size inside the 1 MB body; propagates to agent, outbox, webhooks | 1 h |
| L5 | Low | platform-api | `POST /v1/webhook/deliveries/:id/retry` re-sends already-delivered events | 1 h |
| L6 | Low | mediator | The open multi-use startup invitation is still created and printed to logs | 2 h |
| L7 | Low | mediator | `webhook-sink` debug container runs permanently in the stack | 10 min |
| L8 | Low | dev machine | `console/.staging/` holds a live staging API key, owner password and TOTP secrets in plaintext (git-ignored) | rotate |
| L9 | Low | agent-service | Askar Postgres pool size not set (`maxConnections` default) vs `TENANT_SESSION_LIMIT` 100 | verify in Phase 8 |
| L10 | Low | platform-api | Console audit records route + status only, never the change; a bad edit cannot be reconstructed | 0.5 d |
| L11 | Low | console | Tenant-member sessions last 7 days sliding (operators 12 h) | 10 min |
| L12 | Low | all | npm audit: transitive moderates only (valibot via unused `dcql`; esbuild via `drizzle-kit`) | with next Credo bump |
| L13 | Low | mediator | Valkey runs `noeviction` for what is now a pure cache (streams unused since multi-instance delivery is `none`): it refuses writes instead of evicting when full (§8) | 10 min |
| L14 | Low | platform-api | Every credential offer and proof request makes an internal HTTP round trip to agent-service for the rarely-changing catalogue; no cache (§8) | 2 h |
| L15 | Low | platform-api | `GET /v1/ledger` is static config served with no `Cache-Control`, though every SDK installation fetches it (§8) | 10 min |
| I1 | Info | agent-service | `isProduction: false` in the Indy VDR network config; production checklist item | — |
| I2 | Info | edge | `per_ip_limit` exempts all of `10.0.0.0/8` (provider hairpin); harmless on this host, wrong on a multi-tenant provider network | — |

**Bucket B cross-check** (every item from the former `15-next-step.md` bucket B appears above): catalogue timeout → M5; orphaned wallets → M10; per-key rate limit → M4; mediator queue retention → M10; minisign on device → M15; SMTP invitation run / 12 h session cap → §9 not checked; upstream bug filing → M17 (CI/release hygiene); alert e-mail → M16; owner items (age key, `ubuntu` password, corrupted tenants) → M13, L8, §9.

**Corrections to earlier notes:** the plan assumed "no non-root containers" — wrong, both images run `USER node` (`services/Dockerfile:24`, `console/Dockerfile:21`). The plan also placed trap 44 in the platform-api client (10 s); the client default is already 30 s (`agent-client.ts:96`) and the real cause is in agent-service (M5).

---

## 2. Findings — Track 1: platform-api

### H1 · High · No retention or deletion path for personal data
**Where:** `services/platform-api/src/db/schema.ts` (`credentials.attributes`, `proofs.disclosed`, `webhook_deliveries.body`), `services/agent-service/src/db/schema.ts` (`outbox.payload`), the tenant Askar profiles (Credo credential/proof exchange records keep the offer and the presentation).
**What:** attribute values and disclosed proof values are written to the platform mirror on every offer (`http/routes/exchanges.ts:88`) and completion (`outbox-consumer.ts:105-116`), copied into each webhook body (`webhooks/events.ts:52`), and kept by Credo in the tenant profile. There is no `DELETE` on credentials/proofs/connections, no retention job, and `outbox` rows are never pruned.
**Evidence:** *source read*; the only DELETE routes are api-keys, proof-templates, wallets (revoke), webhook (endpoint). No `delete(` on any exchange table in either service.
**Impact:** §5.3 tells customers "delete our platform records" answers an erasure request; today nothing can. Every enterprise legal review will ask. Also unbounded table growth.
**Fix:** (a) `DELETE /v1/credentials/{id}`, `/v1/proofs/{id}`, `/v1/connections/{id}` that scrub `attributes`/`disclosed`, null the delivery bodies for that record, and call a new agent-service route that deletes the Credo exchange record; (b) a tenant-level retention setting (default e.g. 90 d after `done`/`abandoned`) enforced by a nightly job over the mirror tables, `webhook_deliveries` (keep metadata, null the body) and `outbox`; (c) write the customer-facing §5.3 document from what (a)+(b) actually do. Test: unit test per table + a staging run that issues, deletes, and greps every store for the value.
**Added by Phase 6 (biometric gate):** (a) and (b) must also cover the biometric log. That means platform-api `exchange_gates` and `exchange_gate_events` (scores, decisions, AWS session ids) and biometric-service `checks`, `sessions` and `results`. Phase 6 deliberately ships **no automatic deletion** of these; face images themselves are already deleted at decision time.

### M2 · Medium · Webhook dispatcher head-of-line blocking
**Where:** `services/platform-api/src/webhooks/dispatcher.ts:95-127` — `for (const delivery of claimed) { … await deliverOnce(…) }` with `batch = 20`, `timeoutMs = 10_000`.
**Evidence:** *source read*. Deliveries are attempted strictly one after another; the claim is global, not per tenant.
**Impact:** one customer endpoint that hangs makes each tick take up to 20 × 10 s; every other tenant's `credential.state_changed` waits behind it. The wake path (`wallet.sync_requested`, the push trigger) is delayed by an unrelated tenant.
**Fix:** attempt the claimed batch with bounded concurrency (e.g. 8) and at most 1–2 in flight per tenant, or claim per tenant round-robin; keep `inFlight` accounting for drain. Test: dispatcher test with one endpoint that sleeps 9 s and one fast one; assert the fast delivery completes in < 1 s.

### M4 · Medium · **B** No per-principal rate limit; unbounded invitation minting
**Where:** `infra/staging/Caddyfile` (`api_per_ip 600`), `services/platform-api/src/http/routes/wallets.ts:104-113`.
**Evidence:** *source read*; 10-phase-3 "Rate limits: per-IP only".
**Impact:** a leaked or abusive key behind a large NAT is indistinguishable from the rest of that NAT. `GET /v1/wallet/mediator-invitation` calls the mediator and creates an out-of-band record with **no expiry** (`infra/staging/mediator/patch/agent.js:107`; 10-phase-3 "There is no expiry on OOB records") on every call — a wallet-token holder can grow the mediator's `DidcommOutOfBand` table without bound.
**Fix:** `@fastify/rate-limit` keyed on `request.tenant.principal` / `request.wallet.id` after auth (per key e.g. 300/min; per wallet 10/min; the invitation route 3 per 10 min); a mediator-side sweep of unused OOB records older than 24 h (SQL job against the Drizzle DB with a dedicated role, or a second patched route). Test: unit test hitting the limit; staging probe expecting 429.

### M6 · Medium · Lost webhook event on a crash mid-row
**Where:** `services/platform-api/src/outbox-consumer.ts:159-167`: `applyRow` (mirror upsert with the `last_outbox_id` guard) → `enqueueEvent` → `writeCursor`, three separate transactions.
**Evidence:** *source read*. A crash after the upsert but before `enqueueEvent` leaves the cursor behind; on restart the same row is re-read, the guard `lastOutboxId < excluded.last_outbox_id` makes the upsert a no-op, `applyRow` returns `null`, and no event is ever enqueued.
**Fix:** run upsert + enqueue + cursor advance in one `db.transaction`. Test: inject a throw between the two calls, restart the consumer, assert the delivery row exists.

### M8 · Medium · Delivery URL snapshot
**Where:** `services/platform-api/src/webhooks/events.ts:52` stores `url: endpoint.url`; `dispatcher.ts:108` posts to `delivery.url`.
**Impact:** after `PUT /v1/webhook` with a new URL (or `DELETE /v1/webhook`), pending retries (12 attempts over about a day) keep posting signed customer data to the old host. If the change was made *because* the old host was compromised, this defeats it.
**Fix:** resolve the URL from `webhook_endpoints` at send time (the secret already is, `dispatcher.ts:99`); on `DELETE` mark pending rows `dead` with `lastError: 'endpoint removed'`. Test: dispatcher test changing the URL between attempts.

### M9 · Medium · No overlap on secret rotation
**Where:** `services/platform-api/src/http/routes/webhook.ts:81-86`.
**Impact:** every delivery in flight or retried after rotation is signed with the new secret; the customer's receiver, still on the old one, rejects it → dead letters on every rotation.
**Fix:** keep `previous_secret` + `rotated_at`; send both `v1=` MACs for 24 h (Stripe pattern). Test: signer test with two secrets.

### M10 · Medium · **B** Orphans: wallets, mediation, queue rows
**Where:** `wallets.ts:52` (create without an idempotency key), `wallets.ts:75-88` (revoke keeps the device's mediation), mediator `message_pickup.queued_message` (12 `pending` rows for dead holders, former bucket B).
**Impact:** the mediator relays and queues for wallets the platform no longer maps; the relay is exactly the resource §2.3 says to protect. Never-connected wallets accumulate.
**Fix:** nightly job: wallets with `mediator_connection_id IS NULL` older than 7 d → revoked; revoked wallets → delete their mediator connection, mediation record and queued rows (needs a write path to the mediator: a third patched admin route `DELETE /admin/connections/:id`, or a SQL job with a dedicated role); queued rows older than 30 d → delete with a metric. Test: staging run with a throw-away wallet.

### L3 · Low · Pagination and indexes
`exchanges.ts` list routes: `limit ≤ 200`, ordered by `createdAt desc`, no cursor — a tenant with more than 200 connections cannot list the rest. Queries filter `(tenant_id, state)` and sort by `created_at`; only the `(tenant_id, record_id)` PK and `(tenant_id, connection_id)` indexes exist (`db/schema.ts:73,89,106`). Fix: `?after=<createdAt,recordId>` cursor + index `(tenant_id, created_at desc)` on the three mirror tables. *Index half planned in Phase 4 C8 (`11-phase-4.md` §C8, migration `0003_stats_indexes`: `(tenant_id, created_at desc)` and `(tenant_id, state)` on all three tables, needed by the dashboard aggregates); the cursor half stays here.*

### L4 · Low · Unbounded attribute record
`exchanges.ts:80` `attributes: z.record(z.string(), z.string())` — bounded only by the 1 MB `bodyLimit`; the schema route itself caps at 125 attribute names of 100 chars (`catalogue.ts:68`). Fix: `.max(125)` keys, 100-char names, 4 KB values; the same on agent-service `command-routes.ts:139`.

### L5 · Low · Retry of delivered events
`webhook.ts:113-121` sets `pending` regardless of the current status. Fix: `where status in ('dead', 'pending')`.

### L10 · Low · Audit log has no diff
`http/audit.ts:31`: actor, role, tenant, method, route, status. Fix: add a redacted request-body snapshot (secrets dropped) for mutating routes.

### Strengths (keep)
Hashed tokens with prefix lookup and length-checked `timingSafeEqual` (`auth/tokens.ts`, `credo-base/src/internal-token.ts`); a tenant predicate on every mirror query and every agent call (verified route by route in `exchanges.ts`, `wallets.ts`, `webhook.ts`, `console.ts`, `proof-templates.ts`); idempotency reserved on arrival, per tenant, URL in the hash, secrets never stored (`idempotency.ts`); response serialisation by schema (no field leaks); generic 5xx bodies (`errors.ts`); HTTPS-only webhook URLs with `redirect: 'manual'` and a timestamped HMAC (`signer.ts`) — this closes SSRF into the Docker network without a private-IP list; `bodyLimit` 1 MB; `SKIP LOCKED` claim so a second replica is safe; graceful drain; `x-admin-token` accepted only on `/admin/*`, which the edge refuses.

---

## 3. Findings — Track 2: agent-service, endorser-service, credo-base

### M1 · Medium · Public DIDComm endpoint: 5 MB junk, serial processing
**Where:** `node_modules/@credo-ts/node/build/transport/DidCommHttpInboundTransport.mjs:19` (`limit: "5mb"`), `services/agent-service/src/config.ts` (`PROCESS_MESSAGES_CONCURRENTLY` default false), `Caddyfile` (`agent_per_ip 300`, no `request_body`).
**Evidence:** *run* — `POST https://agent.<domain>/ -H 'content-type: application/ssi-agent-wire' --data '{"protected":"x"}'` → `500 Error processing message` with `X-Powered-By: Express` (junk reaches Credo). The body limit and serial processing are *source read*.
**Impact:** 300 × 5 MB per minute per IP is JSON-parsed and unpacked in the one queue every tenant shares; legitimate holder replies (credential requests, presentations) wait behind it. No authentication exists on this endpoint by design.
**Fix:** Caddy `request_body { max_size 256KB }` on the `@didcomm` handle (a v1 credential message with 125 attributes is far below this — measure and set with margin); lower `agent_per_ip` to about 60/min; consider a small Express handler before the transport that answers 400 for a body that is not a JWE envelope; schedule the concurrency switch for the Phase 8 load test. Test: staging probe expecting 413 for a 300 KB body.

### M3 · Medium · Unlimited ledger writes per API key
**Where:** `services/platform-api/src/http/routes/catalogue.ts:68` (any tenant principal), `services/endorser-service/src/policy.ts` (checks *who*, never *how many*).
**Impact:** ledger objects are immutable and, on a production network, cost money or governance; a leaked key can publish thousands of schemas under the tenant's DID in minutes. The endorser audit table records it but nothing stops it.
**Fix:** per-tenant daily quota on schema/cred-def publication in platform-api (default e.g. 20/day, raised by an operator); optional tenant setting "console only" so API keys cannot publish; endorser-service refuses above a hard ceiling per tenant per day as the second line. Test: unit tests on both.

### M5 · Medium · **B** Trap 44 re-diagnosed: `connectionTimeout` on the internal API
**Where:** `services/agent-service/src/http/internal-api.ts:43` `connectionTimeout: 10_000`; `services/platform-api/src/agent-client.ts:96` default `timeoutMs = 30_000` (not passed from `main.ts`, so 30 s).
**Evidence:** *source read*. Fastify's `connectionTimeout` is Node's `server.timeout`: the socket is destroyed after 10 s of *inactivity*, and a handler still publishing a credential definition has written nothing. The client then sees a socket error, not a timeout — which is the `502 agent_unreachable` with both services healthy in 14-phase-5 finding 11. The platform client's 30 s never fires.
**Fix:** on the internal API set `connectionTimeout: 0` and use `requestTimeout` (headers) plus per-route deadlines; better, make `POST /tenants/:id/credential-definitions` return 202 and let the catalogue row's `status` carry the result (the catalogue already persists action state, 8-phase-2 T2). Test: a route that sleeps 15 s answered through the real server.

### M7 · Medium · Outbox settle window skips slow commits
**Where:** `services/agent-service/src/http/outbox-routes.ts:41-46` (`createdAt <= now − 2 s`); the consumer advances its cursor past every row it saw.
**Evidence:** *source read*; the file's own comment names the gap ("anything but a stalled insert").
**Fix:** either insert outbox rows inside the same transaction as the state change so ids and commits are ordered, or hold the cursor below `txid_current_snapshot()`'s xmin (the "xmin horizon" pattern). Test: two concurrent inserts, the lower id committing later.

### H2 · High · One internal token, one shared network → platform-api can reach the endorser
**Where:** `infra/staging/compose.agent.yml`: `INTERNAL_API_TOKEN`, `ENDORSER_SERVICE_TOKEN` and the endorser's `INTERNAL_TOKEN` are all `${AGENT_INTERNAL_TOKEN}`; `endorser-service` is on `[default, mediator]`; `compose.platform.yml`: `platform-api` is on `[agent, mediator]` and holds `AGENT_API_TOKEN = ${AGENT_INTERNAL_TOKEN}`.
**Evidence:** *source read*. Both containers share `12id-mediator`; the endorser accepts the token platform-api already has.
**Impact:** §12.10 keeps the endorser key out of the internet-facing process, but the internet-facing platform-api can `POST http://endorser-service:3420/endorse` with a valid token. The policy still limits what gets signed (registered tenant DIDs only), so this is not "sign anything", but the isolation the design claims is not there.
**Fix:** three distinct tokens (`PLATFORM_TO_AGENT`, `AGENT_TO_ENDORSER`, `MEDIATOR_ADMIN`); a dedicated `12id-endorser` network shared only with agent-service (the endorser needs the mediator network today only for Postgres — see H3). Test: `docker compose exec platform-api node -e 'fetch("http://endorser-service:3420/healthz")'` → ENOTFOUND.

### H3 · High · Superuser everywhere; endorser store in the mediator's Postgres
**Where:** `compose.agent.yml` (`POSTGRES_USER: postgres` for agent-service and endorser-service; `DATABASE_URL=postgresql://postgres:…`), `compose.platform.yml` (same), `compose.console.yml` (same), `compose.mediator.yml` (the mediator as `postgres`); the endorser Askar store `endorser` is on the **mediator** instance (`POSTGRES_HOST: postgres:5432`, `init.sql`).
**Evidence:** *source read*. Only `platform_ro` (Phase 3 P9) is a scoped role.
**Impact:** a SQL injection or RCE in any one service (the mediator is third-party code facing the internet) yields every database on that instance, including the encrypted endorser store and all tenant wallets — Askar-encrypted, but the store keys are one `docker inspect` away (M11).
**Fix:** one role per service with `CONNECT` and ownership of its own database only (`agent_service`, `endorser_service`, `platform_api`, `console`, `mediator_drizzle`, `mediator_pickup`, `agent_askar`, `endorser_askar`); move the `endorser` Askar database to a Postgres the mediator cannot reach (the agent instance, or its own); Askar's `adminAccount` only for provisioning. The restore drills already exist — re-run them after the role change. Test: `psql` as each role against another database → permission denied.
**Added by Phase 6:** the `biometric` database (biometric-service) also lives on `agent-postgres` and connects as `postgres`. It needs its own role like the others. Revisit a dedicated instance only if production moves to instance-level backups or the role split cannot isolate it (`16-phase-6-biometric.md`).

### L9 · Low · Askar pool size
`credo-base/src/askar-postgres.ts:24` sets only `connectTimeout`; `maxConnections` is Askar's default. With `TENANT_SESSION_LIMIT=100` and serial processing this is fine today; verify under the Phase 8 load profile before enabling concurrency.

### Strengths (keep)
The endorser signs and never submits; role-less NYM only; the author must be the tenant's bound DID; already-signed / multi-signed requests refused; sha256 of every request audited **before the signature is released** (`endorser-api.ts:97-108`); single-flight onboarding with compare-and-set (`tenants/single-flight.ts`); `InMemoryLruCache` without `useCachedStorageService` (T1); pino redaction of `key`/`password`/`storeKey` at three depths (`credo-base/src/logger.ts:17-20`); genesis pinned by sha256 at start; drained shutdown; reconciliation of stuck exchanges; both images run as `USER node`.

---

## 4. Findings — Track 3: staging infra

### Probes (run 2026-09-16 from outside; `<d>` = `12id.naziharitsolution.com`)
```
GET https://api.<d>/admin/tenants  /Admin/…  /ADMIN/…  //admin/…  /admin/../admin/…  /%61dmin/…  /admin%2Ftenants
    /internal/mediator/x  /admin/tenants?x=1  /./admin/…  /v1/../admin/…                      → 404 (all)
GET https://api.<d>/v1/connections with X-Console-Token / x-console-token / X-CONSOLE-TOKEN    → 404 (all)
    with x-console-actor + x-console-role only                                                → 401
GET https://mediator.<d>/invite  /Invite  /invite?_oobid=x  //invite  /admin/invitations  /admin%2Finvitations
    POST /admin/invitations                                                                   → 404 (all)
GET https://agent.<d>/ → 404   GET /readyz → 200   POST / (junk) → 500 "Error processing message"   POST /x → 404
GET https://ledger.<d>/register → 403;  /status /genesis /ledger/domain /ledger/pool /browse/domain → 200
GET https://grafana.<d>/login → 200;  /api/health → 200
GET https://vdr.<d>/status → 404;  POST /submit → 405
TCP 123.176.58.72: 22 80 443 9702 9704 9706 9708 OPEN;  5432 6379 9000 9090 9093 9701 9703 9705 9707
    3000 3001 3100 3300 3400 3410 3420 3500 3600 8080 closed/filtered
TLS: 1.2 and 1.3 negotiate (Caddy default); 1.0/1.1 not offered by the local OpenSSL, so untested
Headers: api/agent/mediator/grafana carry HSTS, nosniff, no-referrer; agent + mediator add X-Powered-By: Express;
    genesis 404 carries Server: Caddy; apex carries CSP frame-ancestors 'none' + HSTS
```
The edge blocks hold under path normalisation and header casing; the port surface is exactly the designed one.

### M11 · Medium · Secrets as environment variables
**Where:** every `compose.*.yml` `environment:` block (store keys, DB passwords, all tokens, `BETTER_AUTH_SECRET`).
**Impact:** `docker inspect`, `/proc/<pid>/environ`, `ps e`, child processes and crash reports all carry them; the tmpfs decryption (`infra/scripts/deploy.sh:35-37`) protects the file on disk, not the running container.
**Fix:** Compose `secrets:` (file mounts under `/run/secrets`) with each service reading `*_FILE` variants; keep SOPS as the source. Test: `docker inspect` shows no secret values.

### M13 · Medium · Backups on the VM, one age recipient
**Where:** `infra/scripts/backup-postgres.sh:12,23` (`KEEP_DAYS` rotation, VM-local), `.sops.yaml` (single recipient), the owner item "back up the age key" (Appendix A).
**Impact:** disk loss or a mis-typed `rm` takes the data and the only key that decrypts the backups; the script's own header calls this "not a production pattern".
**Fix:** a second age recipient (operator's offline key) on both SOPS and backups; nightly copy to object storage in another provider/region; a restore drill from the off-site copy. Owner decision on where.

### M16 · Medium · Alert coverage
**Where:** `infra/staging/monitoring/alerts.yml` — 14 alerts, all infrastructure-level (targets, TLS, ledger, mediator queue, disk, memory, restarts).
**Missing:** `webhook_deliveries` dead count rising; outbox lag (`max(outbox.id) − outbox_cursor.last_id`); endorser `allowed = false` rate; platform-api / agent-service 5xx rate; mediator `DidcommOutOfBand` and `DidcommMediation` record growth (the open-relay signal beyond the spike alert); idempotency table size. Alert e-mail still needs the app password (owner). Fix: the postgres-exporter custom queries already exist (`monitoring/postgres-exporter-queries.yml`) — add these and their rules; fire each once deliberately (Phase 1 item still open).

### M17 · Medium · Mutable tags, drifted stacks, no CI
**Where:** `compose.agent.yml` `12id/services:phase3` vs `compose.platform.yml` `12id/services:phase4` (same Dockerfile, different builds); `postgres:15-alpine`, `valkey/valkey:8-alpine`, `node:22-alpine` (webhook-sink) unpinned; `nazihar/12id` has no `.github/`.
**Impact:** "what is running" cannot be answered from the repo; a `docker compose pull` can move a database major silently; every gate in this file was run by hand.
**Fix:** tag images by git SHA and deploy both stacks from the same one; pin base images by digest; 5b.3 CI (PR: typecheck + tests + `npm audit --audit-level=high` + `check:client` + SDK `apiCheck`; tag: build, push, `services/VERSIONS.md`).

### M18 · Medium · The mediator's databases have no secondary indexes
**Where:** DDL read out of the pinned image `mediator:375518d` (`@credo-ts/drizzle-storage@0.6.0`, `migrations/{core,didcomm,tenants,…}/postgres/*.sql`) and `phase0/mediator-src/packages/transport-queue-postgres/migrations/001-initial-schema.sql`.
**Evidence:** *run* — `CREATE INDEX` count per bundle: core 0, didcomm 0, tenants 0, action-menu 0, drpc 0, question-answer 0, openid4vc 0, anoncreds 1. The only constraints are the composite PK `(context_correlation_id, id)` and `UNIQUE (context_correlation_id, thread_id)` on connections. The pickup queue has `(connection_id)`, `(connection_id, state)`, `(created_at)` but nothing on `recipient_dids`.
**What runs against them:** each inbound envelope — including every wallet's `PickUpV1` poll every 10 s — is unpacked and then resolved: `Did` by `recipient_key_fingerprints` (jsonb, no GIN) → `DidcommConnection` by `did` / `their_did` (no index); a `forward` is routed by `DidcommMediation.recipient_keys` (text[], no GIN); a connection request is matched to `DidcommOutOfBand.invitation_requests_thread_ids` (text[], no GIN); the queue take is `WHERE (connection_id = $1 OR $2 = ANY(recipient_dids)) AND state = 'pending' ORDER BY created_at` (`patch/TransportQueuePostgres.js:105-110`) — the `OR … ANY(text[])` branch defeats the `connection_id` index, so it scans the whole queue per poll. platform-api's own `select out_of_band_id from "DidcommConnection" where id = $1` (`mediator-client.ts:56`) hits the *second* column of the composite PK, also a scan (cached per wallet, so once).
**Impact:** with N mediated wallets, each poll reads O(N) rows of `Did` and `DidcommConnection`, and N wallets poll every 10 s: row reads per second grow as N²/10. At 10 k wallets that is on the order of 10⁷ row reads per second on a 4 vCPU host — the mediator falls over long before WebSocket count or CPU on crypto matters. Nothing today shows it: staging has a handful of wallets.
**Fix (cheap, ours to own since we already patch the image):** an `002-12id-indexes.sql` applied by `Dockerfile.migrate` after the Drizzle migration:
```sql
create index if not exists did_rkf_gin on "Did" using gin (recipient_key_fingerprints);
create index if not exists did_did_idx on "Did" (context_correlation_id, did);
create index if not exists conn_did_idx on "DidcommConnection" (context_correlation_id, did);
create index if not exists conn_their_did_idx on "DidcommConnection" (context_correlation_id, their_did);
create index if not exists conn_oob_idx on "DidcommConnection" (out_of_band_id);
create index if not exists conn_id_idx on "DidcommConnection" (id);
create index if not exists mediation_conn_idx on "DidcommMediation" (context_correlation_id, connection_id);
create index if not exists mediation_rk_gin on "DidcommMediation" using gin (recipient_keys);
create index if not exists oob_thread_idx on "DidcommOutOfBand" (context_correlation_id, thread_id);
create index if not exists oob_req_threads_gin on "DidcommOutOfBand" using gin (invitation_requests_thread_ids);
create index if not exists oob_rkf_gin on "DidcommOutOfBand" using gin (recipient_key_fingerprints);
create index if not exists queued_recipient_dids_gin on queued_message using gin (recipient_dids);
create index if not exists queued_pending_idx on queued_message (connection_id, created_at) where state = 'pending';
```
Confirm the exact predicate shapes with `auto_explain` / `pg_stat_statements` on staging before finalising (the column list above is from the tag → column mapping in drizzle-storage; the planner decides). File upstream alongside the queue bug. Test: `EXPLAIN (ANALYZE)` of a poll's queries with 10 k synthetic `Did` + connection rows, before/after; the Phase 8 load test then measures the real profile.

### L1 · Low · Header hygiene
*run*: `X-Powered-By: Express` on `agent.` and `mediator.`; HSTS `max-age=31536000` without `includeSubDomains`/`preload`; `Server: Caddy` on `genesis.` 404s. Fix: `header -X-Powered-By` in the `hardening` snippet; `Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"` (every subdomain is TLS already); `handle_errors` on genesis.

### L2 · Low · Grafana and the ledger browser are public
Grafana has its own login and rate limit; the von-network browser exposes `/status` (node versions, uptime) and all ledger reads. Both are staging-only components, but they will be copied to production unless the runbook says otherwise. Fix: `basic_auth` or an IP allowlist in Caddy for both; production should have neither.

### L6 · Low · The open startup invitation still exists
`compose.mediator.yml` `CREATE_NEW_INVITATION: "false"` reuses a **multi-use open-mediation** invitation the image prints at startup; `/invite` is blocked at the edge but the URL is in every replica's log. Fix: patch `index.js` to skip invitation creation when `ADMIN_API_TOKEN` is set, or accept it and restrict log access.

### L7 · Low · `webhook-sink` in the stack
`compose.mediator.yml:167-177` — an unauthenticated HTTP sink that logs whatever it receives; only a debugging aid. Move it to `profiles: [debug]`.

### I2 · Info · Rate-limit exemption for `10.0.0.0/8`
`Caddyfile:19` exempts the provider gateway hairpin; on a provider where other tenants share `10.0.0.0/8` this exempts them too. Narrow to `10.1.1.1/32` (the address the comment names).

### Strengths (keep)
Loopback-only port publishing; `DOCKER-USER` drops on the node-to-node ports (`ufw/after.rules.docker-user`); `/register`, `/invite`, `/admin/*`, `/internal/*` and the console header refused at the edge (probed); SOPS+age with tmpfs decrypt, `shred`, `umask 077`; migration health-checked by table presence; staggered replica start; timing-safe compare in the mediator patch (`patch/agent.js:102-104`); nightly encrypted backups with restore drills for every database; ledger write probe; TLS expiry alert; both Node images non-root.

---

## 5. Findings — Track 4: console

### M12 · Medium · CSP without `script-src`
**Where:** `Caddyfile` apex block: `Content-Security-Policy "frame-ancestors 'none'"`; `console/src/start.ts:17-22` sets nosniff / referrer / frame headers, no CSP.
**Impact:** an XSS in any console dependency, or a crafted tenant name rendered unsafely, runs with the operator's session — every tenant's console scope.
**Fix:** a per-request nonce in `securityHeaders` (`default-src 'self'; script-src 'nonce-…' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`) passed to TanStack Start's script tags; drop the Caddy CSP once the app sets it. Test: a Playwright staging spec that fails on a CSP violation.

### L11 · Low · Session lifetime
`auth.server.ts:56-59`: 7 d sliding for everyone; `middleware.ts:19` caps operators at 12 h. Consider 24 h for tenant members (they manage API keys and webhook URLs).

### Strengths (keep)
A branded `Principal` only the middleware can create; the tenant resolved from the **session's active organization**, never from input (`middleware.ts:88-91`, `platform.server.ts:41-45`); invite-only, 2FA mandatory, operators TOTP-only with the after-hook (`auth.server.ts:66-74`); `disableSignUp`, `minPasswordLength 12`, `revokeSessionsOnPasswordReset`, hashed OTPs; CSRF middleware registered explicitly with the public origin (`start.ts:32-35`); `check-client-bundle.ts` refuses a client bundle containing `x-console-token`; the console reaches platform-api only through the console scope, audited per call; `Cache-Control: no-store` on authenticated server functions.

---

## 6. Findings — Track 5: Android SDK

### M14 · Medium · DEBUG forwarding and `http://` base URL
**Where:** `sdk-android/sdk/src/main/java/org/slf4j/impl/StaticLoggerBinder.kt:102` `isDebugEnabled = SdkLog.sink != null`; framework DEBUG lines include `Proof request json:` (`ariesframework/…/proofs/ProofCommand.kt:148`), `Connection record: {…}` (`connection/ConnectionService.kt:303` — DIDs, DID documents, the invitation), `Parsed Peer DID JSON` (`PeerDIDService.kt:88`); `OneTwoIdConfig.kt` accepts any `apiBaseUrl`; the sample writes the sink to Logcat.
**Impact:** an integrator who wires `logSink` to a crash reporter (the obvious thing to do) ships DIDComm internals and proof-request contents to a third party; a typo `http://` base URL sends the wallet token in clear on API 24–27 (cleartext is only blocked by default from API 28).
**Fix:** `OneTwoIdConfig(minLogLevel = Info)` and never forward framework DEBUG unless the host opts in; refuse a non-`https` base URL outside debuggable builds; document both in `docs/integration.md`. Test: JVM test that a Debug line does not reach a sink configured at Info.

### M15 · Medium · **B** Genesis authenticity
**Where:** `sdk/…/internal/GenesisCache.kt` (sha256 from `/v1/ledger`), `platform-api/src/http/routes/public.ts` (publishes the minisign URL and key).
**Impact:** the hash and the file come from the same TLS origin; a compromised platform-api (or a mis-issued certificate) can point every wallet at a fake ledger — the §6 threat the design names. The minisign key is already distributed; only the verification is missing.
**Fix:** verify the `.minisig` on device against a public key **compiled into the SDK** (the trust anchor; the URL/key from `/v1/ledger` is only a hint); BLAKE2b via a pure-Kotlin implementation (~200 lines) or BouncyCastle if the framework already pulls it in (`./gradlew :sdk:dependencies`); measure the APK delta against 28.7 MB.

### Observations (no finding)
- `internal/KeyWrapper.kt`: AES-256-GCM in the Android Keystore, non-exportable, Keystore-generated IV per wrap, 12-byte IV + 128-bit tag — correct. No user-auth binding is a deliberate trade-off for push-woken `sync()`; offer `setUserAuthenticationRequired` + `setUnlockedDeviceRequired` as an opt-in for customers who need stronger custody.
- `internal/SdkStore.kt`: state in `noBackupFilesDir`, atomic replace; the invitation URL and label are not secrets. The wallet token is never persisted by the SDK (provider callback) — good; the **sample** keeps it in plain `SharedPreferences` (`sample/…/CustomerBackend.kt:19`) — say so in the guide.
- `internal/PlatformClient.kt`: OkHttp 4.12.0, 15 s / 30 s timeouts, platform TLS trust, no pinning — acceptable given M15 is the real anchor.
- Manifest: only `INTERNET`; no `usesCleartextTraffic` flag (M14 covers API 24–27).
- 10 s foreground polling is the framework's `PickUpV1` design; battery and mediator load are Phase 8 measurements.

### Strengths (keep)
Explicit API mode, `apiDump` committed and `ApiSurfaceTest` refusing framework types (30/30 + `apiCheck` green in this review); typed `OneTwoIdException`; `Throwable` caught at the boundary (trap 43); spent-invitation recovery bounded to one retry and only with no organisation connections (trap 31); R8 consumer rules; the slf4j binding that makes stalls diagnosable (trap 40).

---

## 7. Findings — Track 6: cross-cutting

### L12 · Low · Dependency audit
*run* `npm audit --omit=dev --json`:
- `services/` 10 moderate and `infra/ledger/` 9 moderate — all through `@credo-ts/core → dcql → valibot` ("record() issue paths can make flatten() throw"; the OpenID4VC request path, never executed here); npm's "fix" is a downgrade to Credo 0.5.19.
- `console/` 4 moderate — `drizzle-kit → @esbuild-kit → esbuild ≤ 0.24.2` (dev-server CORS issue; `drizzle-kit` runs only in the `console-tools` profile).
No action beyond tracking the next Credo release; add `npm audit --audit-level=high` to CI so a real one is caught.

### L8 · Low · Plaintext staging credentials on the dev machine
`console/.staging/{api-key.txt, api-key-label.txt, owner-password.txt, owner-totp-secret.txt, totp-secret.txt}` — git-ignored (`console/.gitignore:12`, verified with `git check-ignore`), used by the Playwright staging specs. Rotate all four before production; never on a shared machine. Nothing secret is tracked: `git ls-files` grep for `12id_sk_`, `12id_wt_`, `whsec_`, `AGE-SECRET-KEY`, private-key headers and inline Postgres passwords is clean outside `*.sops.env` and test fixtures.

### Index coverage per database (source read of every schema against every query; no `EXPLAIN`, see §8)

| Database | Tables / indexes | Queries checked | Verdict |
|---|---|---|---|
| `platform_api` (`platform-api/src/db/schema.ts`) | 10 tables; unique on token hashes, OOB id, mediator connection id; partial `(next_attempt_at) where status in (pending, sending)`; `(tenant_id, created_at)` on deliveries and audit | every `where`/`orderBy` in `http/routes/*`, `wake.ts`, `dispatcher.ts`, `outbox-consumer.ts`, `idempotency.ts` | Covered except the three mirror tables' list queries (`(tenant_id, state)` filter + `created_at desc` sort) — **L3** |
| `agent_service` (`agent-service/src/db/schema.ts`) | `tenants` (PK, unique nym), `ledger_objects` (unique identity `(tenant, kind, name, version, tag)`, unique qualified/unqualified id), `outbox` (PK range, partial `(id) where delivered_at is null`, `(tenant, type, record)`) | catalogue, deprecation, onboarding, outbox feed + ack | Covered; `deprecation.ts:22` filters `schema_object_id` without an index — tiny per-tenant table, ignore |
| `endorser_service` | `tenant_bindings` (PK), `endorsement_audit` `(tenant_id, created_at)` | `bindings.ts:24`, audit inserts | Covered |
| `console` (Better Auth generated, `console/src/server/db/auth-schema.ts`) | indexes on `session.user_id`, unique `session.token`, `account.user_id`, `verification.identifier`, `member.organization_id` + `member.user_id`, `invitation.organization_id` + `email`, `two_factor.user_id` + `secret`, unique `rate_limit.key`, unique `organization.slug` + `platform_tenant_id` | Better Auth's own lookups; `middleware.ts:69,85` | Covered. Note: nothing purges expired `session`, `verification` or `rate_limit` rows — add to the retention job (H1) |
| Askar stores (`agent_root`, `endorser`, `mediator` KMS) | Askar's own `items` / `items_tags` schema with its indexes | Credo tag queries (`findAllByQuery` in `reconcile.ts`) | Askar's problem, not ours; `PROFILE_PER_WALLET` keeps each tenant's scan bounded |
| mediator `drizzle` (Credo drizzle-storage 0.6.0) | 33 tables, **0 secondary indexes** | every inbound message; platform-api `mediator-client.ts:56` | **M18** |
| mediator `message_pickup` | `(connection_id)`, `(connection_id, state)`, `(created_at)` | queue take, count, delete | `recipient_dids` branch unindexed — **M18** |

### Correlation ids
*spot check*: `correlationId` is threaded through `agent-service/src/exchanges/exchanges.ts` (12 uses), `events/outbox-listener.ts` (10), `platform-api/src/outbox-consumer.ts` (as `externalId`). Fastify request ids are `Math.random`-based 10 chars (`http/app.ts:65`) — fine for support, not a security identifier.

### I1 · Info · `isProduction: false`
`agent-service/src/agent/root-agent.ts:71`. Affects only Credo's network-selection metadata, but belongs on the production checklist next to §12.1.

---

## 8. Shared cache / Valkey — should the other services use it?

**Short answer: do not share the mediator's Valkey, and do not add Redis to any service yet.** Nothing in the platform currently needs it; the things people normally put in Redis are already solved better here. It becomes worth adding — as a **separate instance** — the day a second replica of platform-api, agent-service or the console starts.

### What Valkey actually does today (run)
`compose.mediator.yml:94-104`: `valkey/valkey:8-alpine`, `maxmemory 200mb`, `--maxmemory-policy noeviction`, `--appendonly yes`, `mem_limit 256m`, no `requirepass`, no TLS, reachable to anything on the `12id-mediator` network. The mediator reaches it through `CACHE__TYPE: redis` → `apps/mediator/build/config/cacheLoader.js`, which builds `CacheModule({ cache: new RedisCache(ioredis), useCachedStorageService: true })`. Since `MESSAGE_PICKUP__MULTI_INSTANCE_DELIVERY__TYPE` is pinned to `none` (§2.3), the Redis **streams** path is not in use, so Valkey holds **only Credo's cache** — the compose comment "Delivery uses streams; evicting them would drop messages" is stale.

### Why not share it
1. **`noeviction` + 200 MB is a shared failure mode.** When the instance hits its limit, Valkey refuses *writes* — for every client, not just the one that filled it. The mediator is the single point of failure for every mobile user (trap 8); a console session burst or a rate-limit key flood would take DIDComm delivery with it.
2. **Sharing means widening the network.** The console and agent-service are not on `12id-mediator` today. Putting them there to reach Valkey is the opposite of **H2/H3**, which exist to *reduce* what the internet-facing services can reach. Valkey has no password, so anything on that network can `KEYS *` or `FLUSHALL` the mediator's cache.
3. **Logical DBs are not isolation.** `SELECT 1..15` namespaces keys but shares memory, the AOF file and the single command loop. It prevents key collisions, nothing else.

### Why nothing needs Redis yet (source read)
| Would-be Redis job | How it is done now | Verdict |
|---|---|---|
| Webhook queue | Postgres `FOR UPDATE SKIP LOCKED` + backoff (`dispatcher.ts:82-93`) | Keep. Durable and replica-safe; Redis would trade that away. The §7.1 design note suggesting bullmq was superseded by this, correctly |
| Idempotency | Postgres, reserved on arrival, TTL sweep (`idempotency.ts`) | Keep — it must survive a restart |
| Wake debounce | Compare-and-set on the wallet row (`wake.ts:48-56`) | Keep — durable and exactly-once across replicas already |
| Outbox cursor | Postgres (`outbox_cursor`) | Keep |
| Tenant id resolution | In-process `Map` (`outbox-consumer.ts:31`) | Fine — one entry per tenant |
| Dispatcher `inFlight` | In-process counter (`dispatcher.ts:78`) | Correct as per-replica; it feeds that replica's drain |
| Tenant onboarding single-flight | In-process `Map` (`tenants/single-flight.ts`) **on top of** a compare-and-set on `tenants.status` per transition (`onboarding.ts:91`) | Multi-replica is already *safe* (trap 38's real guard is the CAS); the map only saves duplicate work |

### The three triggers that would justify it (each needs its own instance)
1. **platform-api ≥ 2 replicas** → per-API-key / per-wallet rate limiting (**M4**) needs shared counters. With one replica, an in-process limiter is enough — build M4 in-process now, behind an interface, and swap the store later.
2. **agent-service ≥ 2 replicas** → the Credo ledger cache (`credo-base/src/cache.ts`, `InMemoryLruCache`) is per-replica, so each replica re-reads schemas and cred-defs from the ledger. **`@credo-ts/redis-cache@0.7.0` is published and pins `@credo-ts/core@0.7.0`** (our exact version) with `ioredis ^5.10.1`, so this is a config change, not an implementation. **Caveat: keep `useCachedStorageService: false`** — the mediator sets it `true`, but it is single-tenant; with our tenants it would cache connection records under keys that ignore the tenant context (trap 26). That trap is about the *storage service*, not the backing store, so it applies to Redis exactly as it does to the in-memory cache.
3. **console ≥ 2 replicas** → Better Auth 1.7.4 supports `secondaryStorage` (verified in the installed package) for sessions and rate limiting; today `rateLimit.storage: 'database'` and sessions in Postgres are correct and durable.

### Sessions, short-lived data, and hot reads — the three usual Redis arguments

Checked each against the actual code paths. Only the third has anything in it, and its answer is an in-process cache, not Redis.

**(a) User sessions — no.** Sessions exist only in the console, whose users are invite-only staff (operators and tenant members): tens, maybe low hundreds, ever. Each server function does `auth.api.getSession` (`middleware.ts:55`, unique index on `session.token`), and the operator/tenant middleware adds one or two more indexed lookups (`twoFactor` by `user_id`, `member ⋈ organization`). That is 2–3 index hits per human click — microseconds, and the durability matters (a lost session table logs everyone out mid-task). If console latency ever needs attention, the right lever is **Better Auth's `cookieCache`** (present in 1.7.4), a short-lived signed cookie that skips the session read entirely — no new infrastructure. **Caveat if you enable it:** Phase 4 promises "role change and removal effective on the next request". `tenantMiddleware` re-reads `member` live so tenant roles keep that property, but the **operator** role rides on the session's `user.role`, so an operator demotion would lag by the cache TTL. Keep the TTL at 30–60 s, or leave it off.

**(b) Short-lived data — no, and the reason is durability, not size.** Sort it by whether loss is tolerable:
- **Not tolerable:** idempotency keys (`idempotency_keys`, 24 h) exist precisely so a retry after a crash gets the stored response — losing them creates duplicate wallets and duplicate offers. Password-reset and OTP verification rows likewise. These belong in Postgres.
- **Tolerable:** the 30 s wake debounce (`wake.ts:48-56`) — a lost timestamp just means one extra `wallet.sync_requested`, and the app polls once more. But it is a column on a wallet row the handler **already reads and writes**, so moving it to Redis *adds* a network round trip instead of removing one.

**(c) Frequent reads of rarely-changing data — yes, there is one, and it is not a database problem.** `POST /v1/credentials/offer` (`exchanges.ts:90` → `resolveCredentialDefinition`) and `POST /v1/proofs/request` (`exchanges.ts:149`) each call `agent.listCatalogue(...)` — an **internal HTTP round trip to agent-service plus a DB query there** — on the critical path of every issuance and verification command, to read a catalogue that changes only when someone publishes a schema or credential definition. That is the best caching target in the platform. Fix it with an in-process TTL cache keyed by `agentTenantId` (30–60 s, invalidated on publish/deprecate, which platform-api already routes), not Redis — one replica, no new failure mode (**L14**).

The two per-request credential lookups (`requireApiKey`, `requireWalletToken`) are single indexed reads on small tables and are **deliberately left uncached**: caching them puts a TTL between `DELETE /v1/api-keys/{id}` and the key actually stopping, which trades immediate revocation for microseconds. Not worth it.

Two cheap adjacent wins while in here: `GET /v1/ledger` returns static, env-derived config with **no `Cache-Control`** (verified: `curl -I` shows none) although every SDK installation fetches it — `public, max-age=300` costs nothing (**L15**); and the outbox and webhook workers each poll Postgres every second whether or not there is work (`OUTBOX_POLL_MS` / `WEBHOOK_POLL_MS` default 1000, about 172 k idle queries a day per worker) — cheap, but `LISTEN/NOTIFY` would make both event-driven if the Phase 8 load test says it matters.

### What to do in this phase
- **Nothing shared.** Leave Valkey to the mediator.
- **One small fix (L13):** with streams unused, `noeviction` is the wrong policy for a pure cache — the mediator errors instead of evicting when it fills. Set `--maxmemory-policy allkeys-lru` and correct the stale comment. Revisit if multi-instance delivery ever moves off `none` (it cannot today: `redis` silently disables the webhooks, §2.3).
- **When scaling out:** add a second Valkey to the `12id-agent` network with `requirepass`, its own `mem_limit`, `allkeys-lru`, and `appendonly no` (it is a cache — losing it must be survivable). Do not reuse the mediator's.

## 9. Not checked

- Anything requiring SSH to the VM: `docker inspect` contents (M11 is reasoned from compose), actual Postgres `max_connections`, `EXPLAIN` / `pg_stat_statements` on the hot queries (index coverage in §7 is a source read of schema vs query, not measured plans), on-disk backup permissions, the state of the 12 dead-holder queue rows, whether alert e-mail is configured, the `ubuntu` password rotation, the three corrupted tenants from the onboarding race.
- TLS 1.0/1.1 refusal (the local OpenSSL 3.5 does not offer them); Caddy's default minimum is 1.2.
- Mediator image CVEs (`docker scout` / `trivy` not installed here); the base is `mediator:375518d` (December 2025, Credo 0.6.0, that date's Node image).
- Invited-member acceptance through real SMTP; the operator 12 h cap in practice (both bucket B).
- Everything on iOS; x86_64 / minSdk 24 on Android; restrictive corporate Wi-Fi; a real FCM push; production ledger + TAA — unchanged from `4-init-post-phase-0.md` §0.1.
- Load behaviour (M1, M2, L9) — reasoned from code; Phase 8 (Hardening) measures it.

---

## 10. Recommended fix set — Phase 7: pre-production hardening

**Build now (each under a day unless noted), in this order:**

| # | Findings | Verification |
|---|---|---|
| 1 | H2 + H3: three tokens, endorser network, per-service DB roles, endorser store off the mediator instance | container-to-container probes fail; `psql` cross-database denied; restore drill re-run |
| 2 | M11: file-based secrets | `docker inspect` clean |
| 3 | M1: DIDComm body cap + per-IP tightening | staging probe 413 |
| 4 | M5: internal-API timeout fix (+ async cred-def) | 15 s handler test; `smoke:platform-credo` |
| 5 | M2 + M6 + M8 + M9: dispatcher concurrency, transactional consumer, live URL, secret overlap | dispatcher + consumer unit tests |
| 6 | M4 + M10 + M18: per-principal rate limits; wallet / mediation / queue sweep; mediator index migration | 429 probe; staging sweep run; `EXPLAIN` before/after on 10 k synthetic rows |
| 7 | M3: ledger write quota | unit tests; endorser refusal metric |
| 8 | M12: nonce CSP | Playwright CSP spec |
| 9 | M14: SDK log floor + https check | JVM tests |
| 10 | H1: deletion routes + retention job + the §5.3 customer document (2–3 d) | staging issue → delete → grep every store |
| 11 | L1, L4, L5, L6, L7, L13, L14, L15, I2 | probes / unit tests; `valkey-cli config get maxmemory-policy` returns `allkeys-lru`; one agent-service call per offer instead of two; `curl -I /v1/ledger` shows `Cache-Control` |

**Owner decisions (not code):** M13 off-site backups and a second age recipient; M16 alert channel; M17 / 5b.3 CI and tag policy; L2 whether Grafana and the ledger browser exist in production at all; L8 rotate the `.staging` credentials; §12.1 ledger topology, a clean production host, TAA (bucket C).

**Defer to their phases:** M15 with 5b.1 (the wrapper rebuild changes the size budget); L9, M1's concurrency switch and M2's numbers with the Phase 8 load tests; L3, L10, L11 when those surfaces are next touched.

**Explicitly not doing:** sharing the mediator's Valkey with the other services, or adding Redis anywhere (§8). Build M4's rate limiter in-process behind a small store interface so it can move to Redis the day platform-api runs a second replica.

---

## 11. Document updates made with this review (2026-09-16)
- `4-init-post-phase-0.md` §0.1 and §10: pointer to this file; the review fix set is **Phase 6 — Pre-production hardening** and the former Phase 6 (load tests, failover, key rotation, DR) is now **Phase 7 — Hardening**.
- `15-next-step.md` removed; this file takes its number. Its Phase 5b recommendation (Android SDK release) is preserved in Appendix A and follows Phase 6.

**Renumbering (2026-09-21):** the biometric gate was inserted as **Phase 6** ([`16-phase-6-biometric.md`](16-phase-6-biometric.md)). This file was renamed from `15-phase-6.md` to `15-phase-7.md`, its fix set is now **Phase 7 — Pre-production hardening**, and Hardening is **Phase 8**. The references in the body were updated; the bullets above keep the numbering of their date. Appendix A (5b) now runs after Phase 7.

---

## Appendix A — Phase 5b: Android SDK release (carried over from the removed `15-next-step.md`)

Runs after Phase 7. It is the one item the design names as a first-customer blocker (§9 original: "resolve before the first customer integration"; §12.16): the SDK is local-Maven only, consumers need three repositories, the wrappers' x86_64 libraries do not load (no emulator testing, minSdk 24 unverified), and there is no CI.

**5b.1 Rebuild the UniFFI wrappers under our coordinates** (finding 9 / trap 42)
- Fork `LF-Decentralized-Trust-labs/aries-uniffi-wrappers`; build askar / anoncreds / indy-vdr for `arm64-v8a`, `armeabi-v7a`, `x86_64` (drop the four dead ABIs), linking compiler-rt builtins statically so `__extenddftf2` resolves on x86_64.
- Publish as `com.12id:askar-uniffi-android`, `anoncreds-uniffi-android`, `indy-vdr-uniffi-android`; replace the `org.hyperledger` coordinates in `sdk-android/ariesframework/build.gradle:53-55`; retire `scripts/mirror-uniffi.ps1` and `third_party/m2`.
- Acceptance: the sample onboards on x86_64 emulators at API 24, 26, 28 and 36 **and** still passes `smoke:sdk-android` on the phone. M15 (minisign on device) lands here, since the rebuild resets the size budget.

**5b.2 One repository for consumers**
- Vendor or shade `com.github.multiformats:java-multibase` (only JitPack has it) so `settings.gradle` needs no JitPack entry.
- Decide the public repository: a static Maven repo behind the existing Caddy edge (`maven.<domain>`, same deploy path as genesis) now, Maven Central via the 12id.com namespace later. **Owner decision.**
- The sample consumes SDK + fork + wrappers from that repository exactly as a customer would; `docs/integration.md` collapses to a single-repository snippet.

**5b.3 CI and release pipeline** (GitHub Actions on `nazihar/12id`; also M17)
- PR checks: `services/*` `tsc --noEmit` + `node --test` + `npm audit --audit-level=high`; `console` `tsc` + Vitest + `check:client`; `sdk-android` build + JVM tests + `apiDump` diff.
- Emulator job (x86_64, now possible): the SDK's instrumentation path against staging — the seed of the parity suite iOS joins later.
- Tagged release workflow: publish fork + SDK + wrappers, bump `services/VERSIONS.md`, attach the API dump; images tagged by git SHA (M17).

**Verification**
- `smoke:sdk-android` PASSED on the phone with the SDK resolved from the public repository (no `build/m2`, no mirror, no JitPack).
- Emulator matrix API 24/26/28/36 x86_64: `wallet ready` + one offer accepted.
- CI green on a PR touching all three areas; a tagged release lands in the repository and the sample builds from a clean Gradle cache.

**After 5b:** production readiness (§12.1 ledger decision, a clean production host, TAA run, production endorser + genesis v1 — the actual gate to a paying customer, owner decision first); customer-facing documents (data-protection posture §5.3 once H1 is built, no-revocation + wallet-recovery story, attribute-encoding rules §5.2); then Phase 5-iOS and Phase 8 Hardening.
