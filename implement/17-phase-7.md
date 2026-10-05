# Pre-production review — security gaps and optimization opportunities

**Phase:** this review's fix set is **Phase 7 — Pre-production hardening** (renumbered 2026-09-21 when the biometric gate became Phase 6, [`15-phase-6-biometric.md`](15-phase-6-biometric.md); this file was `15-phase-6.md`, then `15-phase-7.md`, and is now numbered after the Phase 6 docs `15`–`16`). The former Hardening is **Phase 8**.
**Status:**
- The review ran 2026-09-16 and changed nothing itself.
- **Fixed since: H2 and H3, on staging 2026-09-22** (§10 item 1, [`infra/runbooks/postgres-roles.md`](../infra/runbooks/postgres-roles.md)).
- **Re-validated against the code 2026-09-22.** Every medium finding was re-read against the current source:
  - Twelve needed a correction to their impact, fix or status. Each has a **Re-validated 2026-09-22** note under it.
  - A new finding, **K1** (setup routes become console only), was added by owner decision.
  - The §10 order was rewritten.
- **Kept open by owner decision (2026-09-22):** M13 (off-site backups, later) and M17 (tags and CI, in the publishing phase).
- **Fixed since: H1 (and L5), on staging 2026-09-28** (§2 H1 status; customer document `services/platform-api/docs/data-protection.md`).
- **Added 2026-09-28:** L16 (the staging ledger's trustee seed is public), found while planning Phase 9 ([`18-phase-9-production.md`](18-phase-9-production.md)). Phase 9 also closes the owner-held M11, M13 and M17.
- **Fixed since: the Low batch, on staging 2026-09-28** (L1, L4, L6, L7, L13, L14, L15, I1, I2; §10 row 14), and **L10** and **L11** the same day by owner decision.
- **Closed by Phase 9 (`19-phase-9-production-findings.md`):**
  - M11 file secrets, M13 off-site backups with an offline recipient, and M17 digest pins (W2, 2026-09-29);
  - M17's CI, tag-driven (W3; first image release `v0.1.0-rc.1`, 2026-10-04);
  - L2 for production, which gets no public Grafana or ledger browser (W2);
  - L9, verified by the Phase 8 load test, plus M1's concurrency switch measured and kept off (W4, 2026-10-04);
  - M18 completed by the `Did.alternative_dids` index the load test found missing (W4).
- Still open (2026-10-05):
  - M15, with W5's production minisign keys (an SDK release);
  - L16, on staging only (production runs its own ledger);
  - L8, the owner's rotation;
  - L12, with the next Credo release.

Every finding names its file and line. The evidence marker on each finding says how it was checked:
- *run*: its command and output are in this file
- *source read*: verified in the code
- *reasoned*: not exercised

**Scope:** platform-api, agent-service, endorser-service, credo-base, console, Android SDK, staging infra. The bucket-B follow-ups from the former `15-next-step.md` (its Phase 5b recommendation is carried in Appendix A below; the file itself was removed) are re-confirmed and ranked here (marked **B**).
**Baseline runs (all green):** platform-api 36/36 (against the local Phase 2 Postgres), agent-service 43/43, endorser-service 30/30, credo-base 10/10, console Vitest 11/11 + `tsc`, SDK JVM 30/30 + `apiCheck`; `tsc --noEmit` clean in all four services. `npm audit --omit=dev`: 10 / 4 / 9 moderate, all transitive (§7).

Severity is exploitability × impact against the **production** threat model (customer API keys, wallet tokens, endorser key, console token, mediator relay), not staging convenience.

---

## 1. Summary

| ID | Sev | Component | Finding | Effort |
|---|---|---|---|---|
| H1 | High | platform-api, agent-service | **Done 2026-09-28.** Personal data is retained forever in five places and there is no deletion path; §5.3 promises one | 2–3 d |
| H2 | High | infra | **Done 2026-09-22.** One shared internal token and a shared Docker network let platform-api call endorser-service directly (undoes §12.10) | 0.5 d |
| H3 | High | infra | **Done 2026-09-22.** Every service is a Postgres superuser; the endorser store lives in the internet-facing mediator's Postgres with its password | 1 d |
| K1 | Med | platform-api | **Done 2026-09-22.** *Added 2026-09-22.* Every API key can do everything the console can for its tenant: publish to the ledger, change the webhook URL and secret, edit templates and policy. Setup becomes console only | 0.5 d |
| M1 | Med | agent-service, edge | **Done 2026-09-22.** Public DIDComm endpoint accepts 5 MB junk, processed serially for all tenants → cheap cross-tenant DoS | 0.5 d |
| M2 | Med | platform-api | **Done 2026-09-22.** Webhook dispatcher is sequential: one slow customer stalls every tenant's webhooks (up to 200 s per tick) | 0.5 d |
| M3 | Med | platform-api, endorser | **Done 2026-09-22.** Any API key can publish unlimited immutable ledger objects; no quota, no approval | 1 d |
| M4 | Med | platform-api, edge | **Done 2026-09-22.** **B** No per-API-key / per-wallet rate limit; `GET /v1/wallet/mediator-invitation` mints an unexpiring mediator record per call | 1 d |
| M5 | Med | agent-service | **Done 2026-09-22.** **B** Trap 44 root cause: internal API `connectionTimeout: 10_000` destroys the socket during long handlers (cred-def publish) → 502 `agent_unreachable` | 2 h |
| M6 | Med | platform-api | **Done 2026-09-22.** Outbox consumer: a crash between the mirror upsert and the webhook enqueue loses that event for good | 0.5 d |
| M7 | Med | agent-service | **Done 2026-09-22.** Outbox settle window: an insert committing > 2 s after its id is allocated is skipped forever | 0.5 d |
| M8 | Med | platform-api | **Done 2026-09-22.** Delivery rows snapshot the webhook URL: retries keep posting to a URL the customer replaced or removed, up to a day | 2 h |
| M9 | Med | platform-api | **Done 2026-09-22.** Webhook secret rotation has no overlap; in-flight and retried deliveries fail the customer's check | 0.5 d |
| M10 | Med | platform-api, mediator | **Done 2026-09-22.** **B** Orphaned wallets, revoked wallets that stay mediated, and dead-holder queue rows have no sweep | 1 d |
| M11 | Med | infra | **Kept open (owner, 2026-09-23).** Secrets are container env vars: readable via `docker inspect`, `/proc/<pid>/environ`, crash dumps | 0.5 d |
| M12 | Med | console | **Done 2026-09-22.** CSP is only `frame-ancestors 'none'`; no `script-src`/`default-src` | 0.5 d |
| M13 | Med | infra | Backups are VM-local, encrypted to the only age key, which lives on the same VM. **Kept open (owner, 2026-09-22)** | owner + 0.5 d |
| M14 | Med | SDK | **Done 2026-09-22.** Framework DEBUG lines (proof-request JSON, connection records) are forwarded to the host app's `LogSink` with no level floor; `apiBaseUrl` accepts `http://` | 2 h |
| M15 | Med | SDK | **B** Genesis authenticity on device rests on a sha256 from the same platform response (minisign published, not verified) | 1 d |
| M16 | Med | infra | **Done 2026-09-23.** No alerts for webhook dead-letters, outbox lag, endorser refusals, API 5xx rate, mediator OOB growth; alert e-mail unconfigured | 0.5 d |
| M17 | Med | infra | Mutable image tags (`phase3`, `phase4`, `postgres:15-alpine`, `valkey:8-alpine`); agent and platform stacks run different builds of one source tree; no CI. **Stack drift gone since H2/H3 (all on `phase7`); rest kept open for the publishing phase (owner, 2026-09-22)** | 1–2 d (5b.3) |
| M18 | Med | mediator | **Done 2026-09-22.** Credo `drizzle-storage` 0.6.0 creates **no secondary indexes**: every inbound message (each wallet's 10 s poll) sequentially scans `Did` and `DidcommConnection`; the pickup queue's `recipient_dids` branch is unindexed too — the mediator's scaling cliff | 0.5 d |
| L1 | Low | edge | **Done 2026-09-28.** `X-Powered-By: Express` on agent + mediator; HSTS without `includeSubDomains`/`preload`; `Server: Caddy` on genesis 404s | 1 h |
| L2 | Low | edge | Grafana and the von-network browser are public login/info surfaces | 1 h |
| L3 | Low | platform-api | **Done 2026-09-24 (Phase 4 C9).** List routes cap at 200 with no cursor; no `(tenant_id, created_at)` index on the three mirror tables | 0.5 d |
| L4 | Low | platform-api | **Done 2026-09-28.** Offer `attributes` unbounded in count/key/value size inside the 1 MB body; propagates to agent, outbox, webhooks | 1 h |
| L5 | Low | platform-api | **Done 2026-09-28 (with H1).** `POST /v1/webhook/deliveries/:id/retry` re-sends already-delivered events | 1 h |
| L6 | Low | mediator | **Done 2026-09-28 (`-p6`).** The open multi-use startup invitation is still created and printed to logs | 2 h |
| L7 | Low | mediator | **Done 2026-09-28.** `webhook-sink` debug container runs permanently in the stack | 10 min |
| L8 | Low | dev machine | `console/.staging/` holds a live staging API key, owner password and TOTP secrets in plaintext (git-ignored) | rotate |
| L9 | Low | agent-service | Askar Postgres pool size not set (`maxConnections` default) vs `TENANT_SESSION_LIMIT` 100 | verify in Phase 8 |
| L10 | Low | platform-api | **Done 2026-09-28 (owner).** Console audit records route + status only, never the change; a bad edit cannot be reconstructed | 0.5 d |
| L11 | Low | console | **Done 2026-09-28 (owner: 24 h from sign-in).** Tenant-member sessions last 7 days sliding (operators 12 h) | 10 min |
| L12 | Low | all | npm audit: transitive moderates only (valibot via unused `dcql`; esbuild via `drizzle-kit`) | with next Credo bump |
| L13 | Low | mediator | **Done 2026-09-28.** Valkey runs `noeviction` for what is now a pure cache (streams unused since multi-instance delivery is `none`): it refuses writes instead of evicting when full (§8) | 10 min |
| L14 | Low | platform-api | **Done 2026-09-28.** Every credential offer and proof request makes an internal HTTP round trip to agent-service for the rarely-changing catalogue; no cache (§8) | 2 h |
| L15 | Low | platform-api | **Done 2026-09-28.** `GET /v1/ledger` is static config served with no `Cache-Control`, though every SDK installation fetches it (§8) | 10 min |
| L16 | Low | ledger (staging) | *Added 2026-09-28.* von-network's genesis uses public test seeds (Trustee `000000000000000000000000Trustee1`) and its client ports are public: anyone can write to the staging ledger as Trustee. Staging only; production uses its own network (Phase 9) | with Phase 9 W2 |
| I1 | Info | agent-service | **Done 2026-09-28.** `isProduction: false` in the Indy VDR network config; production checklist item | — |
| I2 | Info | edge | **Done 2026-09-28.** `per_ip_limit` exempts all of `10.0.0.0/8` (provider hairpin); harmless on this host, wrong on a multi-tenant provider network | — |

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

**Owner decisions (2026-09-28):**
- **Scrub, never delete.** The rows stay with their ids, state, dates and external id, so dashboards and history keep adding up.
- **Default retention 90 days** (`RETENTION_DAYS`, 0 = keep), with an override per tenant in the console.
- **Who may erase:** API keys, tenant owners and admins, and operators with a required reason. Members may not.
- **Two additions to the finding:**
  - operators see personal data **masked**, and a reveal needs a reason, which is audited;
  - an API key created by an operator is **flagged**, and the tenant's owners get a mail.

**Status (2026-09-28): done on staging.**
- **Erasure on request.** Three routes, open to an API key or the console:
  - `POST /v1/credentials/{id}/erase` and `POST /v1/proofs/{id}/erase`, for finished exchanges only (409 otherwise);
  - `POST /v1/connections/{id}/erase`, the connection plus every exchange on it.
  - An erasure scrubs, everywhere the platform holds the data:
    - `attributes`, `disclosed` and `their_label`;
    - the webhook delivery bodies (pending ones become dead and are never sent);
    - the gate's scores and vendor session ids.
  - It also has the agent delete the Credo exchange record with its DIDComm messages (new agent-service `…/erase` routes), and biometric-service erase its copy of the check (new `POST /checks/:id/erase`; migration `0001_erasure` makes the hash and session-id columns nullable).
  - Every erasure writes a row to the new `erasures` table (who, why, never the data) and sends a `record.erased` webhook. `GET /v1/erasures` lists them.
  - Code: `platform-api/src/erasure.ts`.
- **Retention.** `platform-api/src/retention.ts` runs on the sweep timer and scrubs exactly as a request would, marked `erased_by = 'retention'`. It sends no webhook.
  - The period is `tenants.retention_days`, else `RETENTION_DAYS` (default 90; 0 = keep).
  - It is set through `GET/PUT /v1/data-retention` (PUT is console only, and members get 403).
  - agent-service prunes acknowledged outbox rows after `OUTBOX_RETENTION_DAYS` (30).
  - The console purges expired Better Auth sessions, verification rows and idle rate-limit rows hourly (`console/src/server/data-protection.server.ts`).
- **The dashboards stay right:** the new column `credentials.expires_at` (backfilled) replaces `attributes->>'expiresAt'` in the expiry counts.
- **Migration `0009_data_protection`:**
  - `erased_at`/`erased_by` on the mirror tables;
  - `record_type`/`record_id` on deliveries (backfilled from the body);
  - `retention_days`, `erasures`, `console_audit.reason`, `api_keys.created_by(_role)`.
- **Operator masking.** For the console operator role, platform-api masks attribute values, disclosed values, holder labels and delivery bodies. The `x-console-reveal-reason` header unmasks them and is audited with the reason. The console's delivery dialog has a Reveal form.
- **Console:**
  - "Erase personal data" on finished exchanges and connections (owners and admins; operators with a required reason);
  - an "erased" badge;
  - a **Data protection** page (retention card and erasure log) in the tenant portal and in the operator's tenant view;
  - a "Created by operator" badge on keys, with a mail to the owners.
- **§5.3 customer document:** [`services/platform-api/docs/data-protection.md`](../services/platform-api/docs/data-protection.md). `docs/api.md` gains the erase routes and `record.erased`.
- **Also fixed:** L5. A retry now requires a dead or pending delivery, and an erased one is never retried (409).
- **Evidence:**
  - Tests: platform-api 91/91 (new `data-protection.test.ts`, 10 cases); agent-service 58/58 (new `erase.test.ts`); biometric-service 32/32; console `tsc`, Vitest 29/29, build and `check:client`.
  - Migration on staging: 63/63 credentials got `expires_at`, and 435/435 exchange and biometric deliveries got their record id.
  - Staging probe from the internet with an API key, on a fresh `smoke:platform-credo` connection:
    - the connection erase answered 200 and listed the credential and the proof;
    - afterwards `attributes`/`disclosed`/`theirLabel` were `null`, with state, `verified` and the external id kept;
    - three `record.erased` webhooks arrived;
    - an unknown id answered 404, and `PUT /v1/data-retention` answered 403.
  - A search of the platform rows and delivery bodies for those records found 0 matches for the values, with 10/10 deliveries scrubbed. The agent answered 404 for all three Credo records.
  - The operator view on staging was masked, and a reveal was audited with its reason.
  - `e2e:staging` 3/3, `smoke:platform-credo` PASSED, `smoke:biometric-credo` 18/18.
- **Not covered:**
  - backups keep erased data until they rotate out (7 days). The customer document says so;
  - a restore loses erasures made after the backup (the document says customers repeat them from their `record.erased` webhooks);
  - the mediator never held personal data in clear.

### K1 · Medium · API keys hold setup powers the console already covers (added 2026-09-22)
**Where:** `services/platform-api/src/http/app.ts:133-144` (one customer scope for API keys and the console), `http/auth.ts:91-107` (an API key has no scopes and no expiry). Only three things are console only today: API keys (`routes/console.ts:34`), stats (`routes/stats.ts:188`), and the tenant-wide biometric settings (`routes/biometrics.ts:142-146`).
**Evidence:** *source read*. With an API key, a caller can:
- publish schemas and credential definitions, and deprecate schemas;
- create, update and delete proof templates and both biometric policies;
- set or delete the webhook URL, rotate its secret, and retry deliveries;
- use every exchange and wallet route, and read every record, including attribute values and disclosed values.
**Impact:**
- A leaked key is a full takeover of the tenant's integration. The worst part: it can fill the immutable ledger (M3) and send webhooks and their personal data to an attacker's URL.
- The customer backend only needs exchanges, wallets and reads while running. The console portal already calls every setup route (`console/src/features/portal/portal-data.functions.ts`).
**Fix (owner decision 2026-09-22: setup is console only):**
- These routes answer 403 to an API key:
  - `POST /v1/schemas`, `/v1/credential-definitions`, `/v1/schemas/:id/deprecation`;
  - proof-template create, update and delete;
  - both `PUT …/biometric-policy`;
  - `PUT` and `DELETE /v1/webhook`, `POST /v1/webhook/rotate-secret`, `POST /v1/webhook/deliveries/:id/retry`.
- Every GET stays with the API key.
- Pull `consoleTenant` into a shared `requireConsolePrincipal` in `http/auth.ts`, and tag these routes `CONSOLE_ONLY_TAG`.
- The smokes switch to console headers over the SSH tunnel.
- **Trade-off:** customers can't script their setup. An opt-in setup scope can come later if someone asks.
- Test: an API key gets 403 and the console gets 2xx on every moved route.

**Status (2026-09-22): done on staging.**
- **Built:**
  - `requireConsolePrincipal` in `http/auth.ts`, used by every moved route and by the three existing console-only checks (API keys, stats, biometric settings);
  - the moved routes are tagged `CONSOLE_ONLY_TAG`: the customer `openapi.json` went from 32 to 29 paths and lost the write methods on the paths it kept, and the console client was regenerated;
  - `docs/api.md` now says setup happens in the console.
- **Smokes:** they cannot hold the console token, which never leaves the VM. They make their setup calls through `consoleClient` (`infra/smoke/platform-common.ts`): SSH into the platform container, as `biometric-setup.sh` does. `platform-bootstrap.ts` also prints `PLATFORM_TENANT_ID`.
- **Evidence:**
  - platform-api tests 59/59 (the new K1 test covers eleven write routes);
  - staging probe from the internet with an API key: `POST /v1/schemas`, `PUT /v1/webhook`, `POST /v1/webhook/rotate-secret` and `POST /v1/proof-templates` answer 403; all five GETs answer 200;
  - console `e2e:staging` 3/3;
  - `smoke:platform-credo` PASSED with setup through the console client.

### M2 · Medium · Webhook dispatcher head-of-line blocking
*Phase 9 W4 (2026-10-04): the defaults (8 slots, 2 per tenant) stayed unchanged; at the load test's rates the dispatcher was never the limit.*

**Where:** `services/platform-api/src/webhooks/dispatcher.ts:95-127` — `for (const delivery of claimed) { … await deliverOnce(…) }` with `batch = 20`, `timeoutMs = 10_000`.
**Evidence:** *source read*. Deliveries are attempted strictly one after another; the claim is global, not per tenant.
**Impact:** one customer endpoint that hangs makes each tick take up to 20 × 10 s; every other tenant's `credential.state_changed` waits behind it. The wake path (`wallet.sync_requested`, the push trigger) is delayed by an unrelated tenant.
**Fix:** attempt the claimed batch with bounded concurrency (e.g. 8) and at most 1–2 in flight per tenant, or claim per tenant round-robin; keep `inFlight` accounting for drain. Test: dispatcher test with one endpoint that sleeps 9 s and one fast one; assert the fast delivery completes in < 1 s.
**Re-validated 2026-09-22:** confirmed (the loop is now `dispatcher.ts:99-128`). Changes to the fix:
- Use **fair share, not a hard per-tenant cap.**
  - `WEBHOOK_CONCURRENCY` sets the slots (default 8).
  - When only one tenant has deliveries due, it gets all of them, so a single-tenant self-hosted install is never throttled.
  - When several tenants are waiting, each gets `max(WEBHOOK_PER_TENANT, floor(concurrency / tenants waiting))` slots (default per-tenant value 2).
  - Rows over a tenant's share go back to `pending`.
- Add a test: one tenant with 20 due deliveries runs 8 at once.

**Status (2026-09-22): done on staging.**
- `webhooks/dispatcher.ts` is a pool of `WEBHOOK_CONCURRENCY` slots (default 8), refilled as each attempt finishes.
- The claim is round-robin across tenants (`row_number() over (partition by tenant_id …)`). A tenant holding `WEBHOOK_PER_TENANT` slots (default 2) is skipped while others have work due. A second, uncapped pass lets it use the rest.
- New `test/dispatcher-pool.test.ts`: while one endpoint hangs, the other tenant's 5 deliveries finish in under 1.5 s; a lone tenant reaches 8 concurrent.
- Evidence: platform-api tests 66/66 and agent-service 51/51; staging `smoke:platform-credo` PASSED (all signatures valid, nothing pending) and `smoke:biometric-credo` 18/18 on the new build.

### M4 · Medium · **B** No per-principal rate limit; unbounded invitation minting
**Where:** `infra/staging/Caddyfile` (`api_per_ip 600`), `services/platform-api/src/http/routes/wallets.ts:104-113`.
**Evidence:** *source read*; 10-phase-3 "Rate limits: per-IP only".
**Impact:** a leaked or abusive key behind a large NAT is indistinguishable from the rest of that NAT. `GET /v1/wallet/mediator-invitation` calls the mediator and creates an out-of-band record with **no expiry** (`infra/staging/mediator/patch/agent.js:107`; 10-phase-3 "There is no expiry on OOB records") on every call — a wallet-token holder can grow the mediator's `DidcommOutOfBand` table without bound.
**Fix:** `@fastify/rate-limit` keyed on `request.tenant.principal` / `request.wallet.id` after auth (per key e.g. 300/min; per wallet 10/min; the invitation route 3 per 10 min); a mediator-side sweep of unused OOB records older than 24 h (SQL job against the Drizzle DB with a dedicated role, or a second patched route). Test: unit test hitting the limit; staging probe expecting 429.
**Re-validated 2026-09-22:** confirmed.
- Use an in-process limiter behind a store interface (§8), with defaults of 300/min per key, 60/min per wallet, and 3 per 10 min on the invitation route.
- **Every limit is a setting** (`RATE_LIMIT_API_KEY_PER_MIN`, `RATE_LIMIT_WALLET_PER_MIN`, `RATE_LIMIT_INVITATION_PER_10MIN`; 0 = off), for self-hosting.
- Add an operator override per tenant (nullable `tenants.rate_limit_per_min`) for a busy customer.
- The per-key limit applies even with a single tenant, because it guards against a leaked key.

**Status (2026-09-22): done on staging.**
- `http/rate-limit.ts`: in-process fixed windows behind `RateLimitStore`.
  - Per API key: `RATE_LIMIT_API_KEY_PER_MIN`, default 300. It is overridden per tenant by `tenants.rate_limit_per_min`, set through `PATCH /admin/tenants/:id` and the operator console's API keys page.
  - Per wallet: 60/min. Per wallet on the invitation route: 3 per 10 min.
  - 429 `rate_limited` with `Retry-After`. The console is not limited.
- The invitation half of the fix, the mediator OOB sweep, is in M10 (`POST /admin/sweep`).
- **Staging probe:** a fourth invitation within 10 minutes got 429 with `Retry-After: 600`.
- Evidence: platform-api tests 72/72, endorser-service 32/32, console `tsc` + Vitest 22/22 + build + `check:client`; staging `smoke:platform-credo` PASSED, `smoke:biometric-credo` 18/18, console `e2e:staging` 3/3 on the new build.

### M6 · Medium · Lost webhook event on a crash mid-row
**Where:** `services/platform-api/src/outbox-consumer.ts:159-167`: `applyRow` (mirror upsert with the `last_outbox_id` guard) → `enqueueEvent` → `writeCursor`, three separate transactions.
**Evidence:** *source read*. A crash after the upsert but before `enqueueEvent` leaves the cursor behind; on restart the same row is re-read, the guard `lastOutboxId < excluded.last_outbox_id` makes the upsert a no-op, `applyRow` returns `null`, and no event is ever enqueued.
**Fix:** run upsert + enqueue + cursor advance in one `db.transaction`. Test: inject a throw between the two calls, restart the consumer, assert the delivery row exists.
**Re-validated 2026-09-22:** confirmed and **worse than stated**. The loop is now `outbox-consumer.ts:146-160`.
- **Any error** after the upsert loses the event, not only a crash. The tick catches it, the row is re-read, and the guard makes the upsert a no-op. A transient DB error on the delivery insert is enough.
- The replay also skips `gates.onExchangeState`, so a gated exchange never records `hold_reached` and waits until it expires.
- **The fix above does not work.** `applyRow` calls agent-service over HTTP, and the gate calls biometric-service, so neither fits inside one transaction.
- **Corrected fix: make replay safe.**
  1. Change the guard to `last_outbox_id <= excluded.last_outbox_id`.
  2. The gate is already compare-and-set (`biometric/gate.ts:203-221`).
  3. Make the event id deterministic, `uuidv5("outbox:<row.id>")`, with a unique index on `webhook_deliveries(event_id)` and `onConflictDoNothing` in `enqueueEvent`.
- Test: the enqueue throws once and runs again; exactly one delivery exists, and the gate recorded `hold_reached`.

**Status (2026-09-22): done on staging.**
- Guard `<=` in `outbox-consumer.ts`.
- `outboxEventId(row.id)` (a v5-style UUID) as the event id.
- Migration `0005_webhook_reliability`: unique `webhook_deliveries(event_id)`, and `enqueueEvent` uses `onConflictDoNothing`.
- The new consumer test fails with the old guard and passes with the new one. A replay from a reset cursor adds no delivery.
- Evidence: platform-api tests 66/66 and agent-service 51/51; staging `smoke:platform-credo` PASSED (all signatures valid, nothing pending) and `smoke:biometric-credo` 18/18 on the new build.

### M8 · Medium · Delivery URL snapshot
**Where:** `services/platform-api/src/webhooks/events.ts:52` stores `url: endpoint.url`; `dispatcher.ts:108` posts to `delivery.url`.
**Impact:** after `PUT /v1/webhook` with a new URL (or `DELETE /v1/webhook`), pending retries (12 attempts over about a day) keep posting signed customer data to the old host. If the change was made *because* the old host was compromised, this defeats it.
**Fix:** resolve the URL from `webhook_endpoints` at send time (the secret already is, `dispatcher.ts:99`); on `DELETE` mark pending rows `dead` with `lastError: 'endpoint removed'`. Test: dispatcher test changing the URL between attempts.
**Re-validated 2026-09-22:** only the URL-change half is real.
- **The DELETE case is already handled.** The dispatcher looks up the endpoint at send time, and a missing endpoint marks the delivery `dead` with "webhook endpoint removed" (`dispatcher.ts:102-111`).
- **The retry window is about 2.4 h, not about a day.** There are 12 attempts, and `backoffMs(1..11)` adds up to 8,715 s. The `PUT /v1/webhook` description (`webhook.ts:56`) and `docs/api.md` say "about a day", which is wrong.
- **Fix:** take `url` from the endpoint row the dispatcher already loads. Keep `delivery.url` as the URL actually used on the last attempt. Correct the retry-window text.

**Status (2026-09-22): done on staging.**
- Every attempt posts to the endpoint's current URL, and the row records where it went.
- The retry-window text now says about 2.5 hours in the route description, `docs/api.md` and the console's endpoint dialog.
- The pool test changes the URL between two attempts: the retry goes to the new host.
- Evidence: platform-api tests 66/66 and agent-service 51/51; staging `smoke:platform-credo` PASSED (all signatures valid, nothing pending) and `smoke:biometric-credo` 18/18 on the new build.

### M9 · Medium · No overlap on secret rotation
**Where:** `services/platform-api/src/http/routes/webhook.ts:81-86`.
**Impact:** every delivery in flight or retried after rotation is signed with the new secret; the customer's receiver, still on the old one, rejects it → dead letters on every rotation.
**Fix:** keep `previous_secret` + `rotated_at`; send both `v1=` MACs for 24 h (Stripe pattern). Test: signer test with two secrets.
**Re-validated 2026-09-22:** confirmed, with corrected impact and one trap.
- **Impact:** the signature is computed at send time (`signer.ts:12-15`), so after a rotation **every** delivery carries the new secret, not only retries. A customer who takes longer than the ~2.4 h retry window (see M8) to deploy the new secret loses those events to dead letters. Otherwise deliveries are delayed by up to an hour.
- **Trap:** our own `verifySignature` (`signer.ts:19`) builds a map from the header, so a second `v1` overwrites the first. Customers who copied it would break the same way.
- **Fix:** accept any matching `v1` in `verifySignature`, and document in `docs/api.md` that the header can carry several.

**Status (2026-09-22): done on staging.**
- `webhook_endpoints.previous_secret` and `rotated_at` (migration `0005`). Rotation keeps the replaced secret.
- For 24 h `signPayload` emits `t=…,v1=<new>,v1=<old>`, newest first, so the docs' old first-`v1` snippet keeps working for receivers already on the new secret.
- `verifySignature`, the smoke receiver and the docs snippet accept any `v1`. The console's rotate dialog explains the overlap.
- Tests cover the signer with two secrets, the 24 h window, and a dispatcher test verifying with the old and the new secret.
- Evidence: platform-api tests 66/66 and agent-service 51/51; staging `smoke:platform-credo` PASSED (all signatures valid, nothing pending) and `smoke:biometric-credo` 18/18 on the new build.

### M10 · Medium · **B** Orphans: wallets, mediation, queue rows
**Where:** `wallets.ts:52` (create without an idempotency key), `wallets.ts:75-88` (revoke keeps the device's mediation), mediator `message_pickup.queued_message` (12 `pending` rows for dead holders, former bucket B).
**Impact:** the mediator relays and queues for wallets the platform no longer maps; the relay is exactly the resource §2.3 says to protect. Never-connected wallets accumulate.
**Fix:** nightly job: wallets with `mediator_connection_id IS NULL` older than 7 d → revoked; revoked wallets → delete their mediator connection, mediation record and queued rows (needs a write path to the mediator: a third patched admin route `DELETE /admin/connections/:id`, or a SQL job with a dedicated role); queued rows older than 30 d → delete with a metric. Test: staging run with a throw-away wallet.
**Re-validated 2026-09-22:** confirmed, with two corrections.
- **"Never connected" can't be read from `mediator_connection_id`.** That column is a cache:
  - it is filled on the first mediator webhook (`wake.ts:37`);
  - it is reset whenever the app fetches a new invitation (`wallets.ts:112`).
- **The correct test:** there is no `DidcommConnection` row whose `out_of_band_id` equals the wallet's `mediator_oob_id`. platform-api can already check this through `platform_ro` (`mediator-client.ts:56`), batched with `= any($1)`.
- The console dashboard's count (`stats.ts:163`, Phase 4 C8) uses the same flawed test and gets the same fix.
- **What the user sees if a never-connected wallet is revoked:**
  - They lose nothing, because no credential can have reached that wallet.
  - When the app returns, the SDK asks the backend for a new token.
  - Within 24 h of the original call, `POST /v1/wallets` with the same idempotency key answers 409 `wallet_revoked`, and the backend must create a new wallet with a new key.
  - After 24 h the key has expired, and the same call simply creates a new wallet.
- **Deleting a revoked wallet's mediation cuts that phone off:** it needs `reset()` and re-issue. That contradicts `wallets.ts:77`, so:
  - wait a 30-day grace period after `revoked_at`;
  - update the route description and `sdk-android/docs/integration.md`;
  - use the patched `DELETE /admin/connections/:id` (Credo's repository, not raw SQL).

**Status (2026-09-22): done on staging.**
- **platform-api `src/sweep.ts`** runs hourly (`SWEEP_INTERVAL_MS`) and is idempotent:
  1. It marks `wallets.connected_at` from the mediator's connections by out-of-band id. The wake path now sets it too.
  2. It revokes wallets still unconnected after `WALLET_UNCONNECTED_REVOKE_DAYS` (7), with `revoked_reason = 'never_connected'`.
  3. `WALLET_REVOKED_GRACE_DAYS` (30) after any revocation, it calls the mediator's new `DELETE /admin/connections/:id` (mediation, connection, queue) and sets `mediation_removed_at`.
  4. It calls `POST /admin/sweep`: unused single-use invitations older than 24 h, and queued messages older than 30 d. The reusable startup invitation is kept.
- Migration `0006_wallet_sweep_rate_limits`, which backfills `connected_at` from the cached mapping.
- The dashboard's never-connected count now uses `connected_at`.
- The wallet view gains `connectedAt` and `revokedReason`.
- The revoke description, `docs/api.md` and `sdk-android/docs/integration.md` explain the lifecycle and the 409 `wallet_revoked` handling.
- **Mediator `-p5`:** the two admin routes, token-guarded. Probes: 401 without the token, 400 for a non-UUID, zeros for an unknown id, 404 from the internet.
- **The first staging sweep proved the correction.** The review's rule (`mediator_connection_id IS NULL`, older than 7 d) matched 3 live wallets. The sweep found all 3 (plus one more) connected in the mediator: `connected: 4, revokedNeverConnected: 0`. The old rule would have cut off working wallets.
- Evidence: platform-api tests 72/72, endorser-service 32/32, console `tsc` + Vitest 22/22 + build + `check:client`; staging `smoke:platform-credo` PASSED, `smoke:biometric-credo` 18/18, console `e2e:staging` 3/3 on the new build.
- **Not run:** checking on the phone that the SDK onboards again after a `never_connected` revocation.

### L3 · Low · Pagination and indexes
`exchanges.ts` list routes: `limit ≤ 200`, ordered by `createdAt desc`, no cursor — a tenant with more than 200 connections cannot list the rest. Queries filter `(tenant_id, state)` and sort by `created_at`; only the `(tenant_id, record_id)` PK and `(tenant_id, connection_id)` indexes exist (`db/schema.ts:73,89,106`). Fix: `?after=<createdAt,recordId>` cursor + index `(tenant_id, created_at desc)` on the three mirror tables. **Done by Phase 4 C9, on staging 2026-09-24 (`11-phase-4.md` §C9):** page numbers with a total instead of a cursor (owner decision), the envelope on every list route, and the remaining list indexes in `0007_list_indexes` + `0008_list_order_indexes` (`EXPLAIN` in `12-phase-4-findings.md` §C9). *Index half planned in Phase 4 C8 (`11-phase-4.md` §C8, migration `0003_stats_indexes`: `(tenant_id, created_at desc)` and `(tenant_id, state)` on all three tables, needed by the dashboard aggregates); the cursor half stays here.*

### L4 · Low · Unbounded attribute record
`exchanges.ts:80` `attributes: z.record(z.string(), z.string())` — bounded only by the 1 MB `bodyLimit`; the schema route itself caps at 125 attribute names of 100 chars (`catalogue.ts:68`). Fix: `.max(125)` keys, 100-char names, 4 KB values; the same on agent-service `command-routes.ts:139`.

**Re-validated 2026-09-28:** confirmed, and the offer route's `bodyLimit` has been 8 MB since Phase 6 (the gate's reference image), not 1 MB. **Also missed:** 125 values of 4 KB each would be 500 KB. Each value travels raw in the offer and in the credential, and the credential is base64-encoded and encrypted twice on its way to the holder. So the fix also needs a total, or the credential would exceed the 512 KB DIDComm cap (M1).

**Status (2026-09-28): done on staging.**
- **Built:** `services/credo-base/src/credential-values.ts`, one zod schema used by platform-api's offer route and agent-service's offer command. It allows at most 125 attributes, names of 1–100 characters, values up to 4 KB (counted in bytes), and 64 KB for all names and values together.
- **Documented:** `docs/api.md` (Attribute rules) and the regenerated OpenAPI documents.
- **Evidence:**
  - credo-base `credential-values.test.ts`: the edges of every bound, plus a multi-byte value;
  - platform-api: a 126-attribute offer and a 4,097-byte value both get 400 before any agent call;
  - staging, from the internet with the acme API key: 400 `body/attributes at most 125 attributes` and 400 `… at most 4096 bytes`.

### L5 · Low · Retry of delivered events
`webhook.ts:113-121` sets `pending` regardless of the current status. Fix: `where status in ('dead', 'pending')`.

### L10 · Low · Audit log has no diff
`http/audit.ts:31`: actor, role, tenant, method, route, status. Fix: add a redacted request-body snapshot (secrets dropped) for mutating routes.

**Owner decision (2026-09-28): do it with W1.**

**Status (2026-09-28): done on staging.**
- **Built:** `http/audit-changes.ts`. Each mutating console or break-glass call stores `changes = { params, body }` in the new `console_audit.changes` column (migration `0010_audit_changes`).
- **Replaced before storing, at any depth:**
  - secrets, by key name (`secret`, `token`, `password`, `passphrase`, `private`, `apiKey`, `accessKey`, `signature`) → `[redacted]`;
  - personal data → `[personal data]`: an offer's `attributes` record, `values`, `disclosed`, `referenceImage` and `image`. The audit has no retention or erasure path (H1), so personal data must never enter it. A schema's or a template's `attributes` list holds names only, so it stays;
  - strings over 2,000 characters are shortened, and a snapshot over 16 KB is replaced by its size (the parameters are kept).
- **Opt-out:** a route whose body may hold vendor secrets under any name sets `config: { auditBody: false }` and records only its parameters. Today that is `PUT /v1/biometrics/provider`, the route already excluded from idempotency storage.
- **Read side:**
  - `GET /admin/audit` returns `changes` and `reason`; before, it omitted the H1 `reason` too;
  - the console's audit log has a **Details** dialog per entry. The server function passes `changes` to the browser as formatted JSON text, because a server function cannot type free-form JSON.
- **Evidence:**
  - `audit-changes.test.ts`, 5 cases: secrets at depth, personal data, the opt-out, the caps;
  - `console.test.ts` now checks the stored snapshots (a tenant creation, an offer whose attributes are replaced, a revocation's id, nothing for a read);
  - platform-api 100/100; console `tsc`, Vitest 32/32, build and `check:client`.
  - On staging:
    - migration `0010` applied through the provision job;
    - `e2e:staging` passed 3/3, and `staging-portal` now opens the Details of the owner's key creation, expects the label and rejects `12id_sk_`;
    - the run's 6 audit rows each held the change (key labels, a template definition, ids), and none held a `12id_sk_`, `12id_wt_` or `whsec_` value;
    - `smoke:platform-credo` PASSED, `smoke:biometric-credo` 18/18.
- **Not covered:** a PUT stores the new value, not the old one. The value before a change is the previous audit entry for the same route and id, if that change was made after this release.

### Strengths (keep)
Hashed tokens with prefix lookup and length-checked `timingSafeEqual` (`auth/tokens.ts`, `credo-base/src/internal-token.ts`); a tenant predicate on every mirror query and every agent call (verified route by route in `exchanges.ts`, `wallets.ts`, `webhook.ts`, `console.ts`, `proof-templates.ts`); idempotency reserved on arrival, per tenant, URL in the hash, secrets never stored (`idempotency.ts`); response serialisation by schema (no field leaks); generic 5xx bodies (`errors.ts`); HTTPS-only webhook URLs with `redirect: 'manual'` and a timestamped HMAC (`signer.ts`) — this closes SSRF into the Docker network without a private-IP list; `bodyLimit` 1 MB; `SKIP LOCKED` claim so a second replica is safe; graceful drain; `x-admin-token` accepted only on `/admin/*`, which the edge refuses.

---

## 3. Findings — Track 2: agent-service, endorser-service, credo-base

### M1 · Medium · Public DIDComm endpoint: 5 MB junk, serial processing
*Phase 9 W4 (2026-10-04): the concurrency switch was measured and stays off (no gain). The SDK polls over HTTPS, so `mediator_per_ip` (300/min) counts every poll: one open app uses 6/min, so a carrier NAT with more than about 50 open apps would hit it. Raise or drop the mediator's per-IP limit before go-live; the load test showed the mediator's own CPU, not abuse, is the binding limit (`19-phase-9-production-findings.md` W4).*

**Where:** `node_modules/@credo-ts/node/build/transport/DidCommHttpInboundTransport.mjs:19` (`limit: "5mb"`), `services/agent-service/src/config.ts` (`PROCESS_MESSAGES_CONCURRENTLY` default false), `Caddyfile` (`agent_per_ip 300`, no `request_body`).
**Evidence:** *run* — `POST https://agent.<domain>/ -H 'content-type: application/ssi-agent-wire' --data '{"protected":"x"}'` → `500 Error processing message` with `X-Powered-By: Express` (junk reaches Credo). The body limit and serial processing are *source read*.
**Impact:** 300 × 5 MB per minute per IP is JSON-parsed and unpacked in the one queue every tenant shares; legitimate holder replies (credential requests, presentations) wait behind it. No authentication exists on this endpoint by design.
**Fix:** Caddy `request_body { max_size 256KB }` on the `@didcomm` handle (a v1 credential message with 125 attributes is far below this — measure and set with margin); lower `agent_per_ip` to about 60/min; consider a small Express handler before the transport that answers 400 for a body that is not a JWE envelope; schedule the concurrency switch for the Phase 8 load test. Test: staging probe expecting 413 for a 300 KB body.
**Re-validated 2026-09-22:** confirmed. **Also missed:**
- `mediator.` runs the same Credo HTTP inbound transport with no body cap, and it is the more critical service. It gets the same `request_body` cap.
- Holders behind carrier-grade NAT share addresses, so lowering the per-IP limits can block real users.
  - Lower `agent_per_ip` (to about 120, not 60) only after reading the staging access logs.
  - Leave `mediator_per_ip` alone until the Phase 8 load test.
- These are edge settings, so self-hosters get the recommended values in the self-hosting docs.

**Status (2026-09-22): done on staging.**
- **Built:**
  - Caddy `request_body { max_size 512KB }` on the agent's `@didcomm` handle and on the mediator site;
  - mediator image `12id/mediator:375518d-p3`: the patched `agent.js` gives the WebSocket server `maxPayload: 512 KiB` (ws defaults to 100 MiB, and Caddy's cap does not cover WebSocket frames).
- **Sizing:** a 125-attribute offer or presentation with short values is roughly 30–40 KB of JSON and about 50–60 KB once encrypted and forwarded.
- **Evidence:**
  - a 700 KB POST answers 413 on `agent.` and `mediator.`;
  - a 600 KB WebSocket message is closed with 1009, and a 10 KB one is accepted;
  - both mediator replicas rolled one at a time and are healthy;
  - `smoke:platform-credo` PASSED.
- **Found on the way (trap 50):** the edge container had not seen any Caddyfile change since 2026-09-20. A single-file bind mount keeps the old inode after a tarball sync, so `caddy reload` reloaded the old file. Fixed by recreating the container.
- **Also observed:** Credo holds each rejected HTTP request open for 10 s (`processedMessageListenerTimeoutMs`) because no "processed" event arrives. The serial queue itself moves on immediately, so this only ties up sockets. The per-IP limit bounds it.
- **Not changed:** `agent_per_ip` / `mediator_per_ip` (carrier NAT; to be revisited from access logs and the Phase 8 load test). The phone smoke over the new mediator was not run (needs the device).

### M3 · Medium · Unlimited ledger writes per API key
**Where:** `services/platform-api/src/http/routes/catalogue.ts:68` (any tenant principal), `services/endorser-service/src/policy.ts` (checks *who*, never *how many*).
**Impact:** ledger objects are immutable and, on a production network, cost money or governance; a leaked key can publish thousands of schemas under the tenant's DID in minutes. The endorser audit table records it but nothing stops it.
**Fix:** per-tenant daily quota on schema/cred-def publication in platform-api (default e.g. 20/day, raised by an operator); optional tenant setting "console only" so API keys cannot publish; endorser-service refuses above a hard ceiling per tenant per day as the second line. Test: unit tests on both.
**Re-validated 2026-09-22:** confirmed (`policy.ts` checks who, never how many).
- **K1 removes publishing from API keys altogether**, so the platform-api quota and the "console only" tenant setting are dropped.
- What remains is the endorser-side ceiling, as a backstop against a hijacked console account or a bug:
  - `ENDORSER_DAILY_CEILING`, default 50 across schemas and cred-defs, 0 = off (self-hosting);
  - counted from `endorsement_audit` `(tenant_id, created_at)`.

**Status (2026-09-22): done on staging.**
- `endorser-api.ts` refuses a schema or cred def once the tenant has `ENDORSER_DAILY_CEILING` (default 50, 0 = off) allowed ledger writes in the last 24 h. The refusal is audited. NYMs are never counted.
- The count query was checked against Postgres: allowed schemas and cred defs in the window only.
- Staging's busiest smoke tenant is at 14 per 24 h. Heavy smoke days should reuse `CRED_DEF_ID`.
- Evidence: platform-api tests 72/72, endorser-service 32/32, console `tsc` + Vitest 22/22 + build + `check:client`; staging `smoke:platform-credo` PASSED, `smoke:biometric-credo` 18/18, console `e2e:staging` 3/3 on the new build.

### M5 · Medium · **B** Trap 44 re-diagnosed: `connectionTimeout` on the internal API
**Where:** `services/agent-service/src/http/internal-api.ts:43` `connectionTimeout: 10_000`; `services/platform-api/src/agent-client.ts:96` default `timeoutMs = 30_000` (not passed from `main.ts`, so 30 s).
**Evidence:** *source read*. Fastify's `connectionTimeout` is Node's `server.timeout`: the socket is destroyed after 10 s of *inactivity*, and a handler still publishing a credential definition has written nothing. The client then sees a socket error, not a timeout — which is the `502 agent_unreachable` with both services healthy in 14-phase-5 finding 11. The platform client's 30 s never fires.
**Fix:** on the internal API set `connectionTimeout: 0` and use `requestTimeout` (headers) plus per-route deadlines; better, make `POST /tenants/:id/credential-definitions` return 202 and let the catalogue row's `status` carry the result (the catalogue already persists action state, 8-phase-2 T2). Test: a route that sleeps 15 s answered through the real server.
**Re-validated 2026-09-22:** confirmed (`internal-api.ts:40`) and **wider than stated**. Every long synchronous route is exposed, including:
- `POST /tenants/:id/onboard` (`command-routes.ts:88-91`, a DID registration on the ledger);
- `POST …/schemas` (`:94`).

The fix:
- `connectionTimeout: 0` plus `requestTimeout: 120_000`. Idle keep-alive sockets still close through `keepAliveTimeout`, so drain is unaffected.
- The platform client has one timeout for every call (`agent-client.ts:102`, 30 s). It gets a per-call override, 90 s for publish and onboard.
- The async 202 publish is a follow-up.

**Status (2026-09-22): done on staging.**
- agent-service `internal-api.ts` now sets `connectionTimeout: 0` and `requestTimeout: 30_000`.
- platform-api's agent client gained `ledgerTimeoutMs` (90 s) for onboard, schema and cred-def calls.
- **Evidence:**
  - A new test holds a handler silent for 11 s over a real socket. It failed with `fetch failed` on the old code and passes on the new.
  - agent-service tests 49/49.
  - `smoke:platform-credo` published a cred def in 4.5 s and PASSED.
- **Left:** the async 202 publish (optional).

### M7 · Medium · Outbox settle window skips slow commits
**Where:** `services/agent-service/src/http/outbox-routes.ts:41-46` (`createdAt <= now − 2 s`); the consumer advances its cursor past every row it saw.
**Evidence:** *source read*; the file's own comment names the gap ("anything but a stalled insert").
**Fix:** either insert outbox rows inside the same transaction as the state change so ids and commits are ordered, or hold the cursor below `txid_current_snapshot()`'s xmin (the "xmin horizon" pattern). Test: two concurrent inserts, the lower id committing later.
**Re-validated 2026-09-22:** confirmed. The inserts are fire-and-forget autocommits (`outbox-listener.ts:143`), and the feed filter is at `outbox-routes.ts:43-47`.
- **Neither fix above works:**
  - The first is impossible: Credo commits to Askar, which is a different database.
  - The xmin horizon has an edge case: `nextval` runs before the xid is assigned, so a lower id can hold a higher xid.
- **Corrected fix:** take `pg_advisory_xact_lock(<outbox key>)` in the insert transaction, so outbox commits happen in id order. This also works across replicas. Keep the 2 s window as a margin.
- Rare in practice (it needs a commit stalled by more than 2 s), but there is no recovery: reconciliation only re-emits for exchanges stuck in Credo.

**Status (2026-09-22): done on staging.**
- `events/outbox-writer.ts` `insertOutboxRow`: `pg_advisory_xact_lock`, then insert, in one transaction.
- All four writers use it: the listener, abandonment in `exchanges.ts`, and both reconcile paths.
- New `test/outbox-order.test.ts` (real Postgres): while a writer holds an uncommitted row, a second writer waits and nothing is visible; after the commit the ids are in commit order. 25 concurrent writers lose nothing.
- Evidence: platform-api tests 66/66 and agent-service 51/51; staging `smoke:platform-credo` PASSED (all signatures valid, nothing pending) and `smoke:biometric-credo` 18/18 on the new build.

### H2 · High · ✅ Done 2026-09-22 · One internal token, one shared network → platform-api can reach the endorser
**Where:** `infra/staging/compose.agent.yml`: `INTERNAL_API_TOKEN`, `ENDORSER_SERVICE_TOKEN` and the endorser's `INTERNAL_TOKEN` are all `${AGENT_INTERNAL_TOKEN}`; `endorser-service` is on `[default, mediator]`; `compose.platform.yml`: `platform-api` is on `[agent, mediator]` and holds `AGENT_API_TOKEN = ${AGENT_INTERNAL_TOKEN}`.
**Evidence:** *source read*. Both containers share `12id-mediator`; the endorser accepts the token platform-api already has.
**Impact:** §12.10 keeps the endorser key out of the internet-facing process, but the internet-facing platform-api can `POST http://endorser-service:3420/endorse` with a valid token. The policy still limits what gets signed (registered tenant DIDs only), so this is not "sign anything", but the isolation the design claims is not there.
**Fix:** three distinct tokens (`PLATFORM_TO_AGENT`, `AGENT_TO_ENDORSER`, `MEDIATOR_ADMIN`); a dedicated `12id-endorser` network shared only with agent-service (the endorser needs the mediator network today only for Postgres — see H3). Test: `docker compose exec platform-api node -e 'fetch("http://endorser-service:3420/healthz")'` → ENOTFOUND.
**Status (2026-09-22): done on staging** ([`infra/runbooks/postgres-roles.md`](../infra/runbooks/postgres-roles.md); evidence in `4-init-post-phase-0.md` §10 Phase 7; the rollout found trap 49, the Askar schema per user).
- **Two** networks were shared, not one: endorser-service was also on `12id-agent`, which platform-api joins.
- Tokens: `PLATFORM_AGENT_TOKEN` (platform → agent) and `AGENT_ENDORSER_TOKEN` (agent → endorser, `agent.sops.env` only). The mediator admin and biometric tokens were already separate.
- endorser-service is only on `12id-endorser`, with agent-service and agent-postgres.
- The platform stack no longer decrypts `agent.sops.env` at all.

### H3 · High · ✅ Done 2026-09-22 · Superuser everywhere; endorser store in the mediator's Postgres
**Where:** `compose.agent.yml` (`POSTGRES_USER: postgres` for agent-service and endorser-service; `DATABASE_URL=postgresql://postgres:…`), `compose.platform.yml` (same), `compose.console.yml` (same), `compose.mediator.yml` (the mediator as `postgres`); the endorser Askar store `endorser` is on the **mediator** instance (`POSTGRES_HOST: postgres:5432`, `init.sql`).
**Evidence:** *source read*. Only `platform_ro` (Phase 3 P9) is a scoped role.
**Impact:** a SQL injection or RCE in any one service (the mediator is third-party code facing the internet) yields every database on that instance, including the encrypted endorser store and all tenant wallets — Askar-encrypted, but the store keys are one `docker inspect` away (M11).
**Fix:** one role per service with `CONNECT` and ownership of its own database only (`agent_service`, `endorser_service`, `platform_api`, `console`, `mediator_drizzle`, `mediator_pickup`, `agent_askar`, `endorser_askar`); move the `endorser` Askar database to a Postgres the mediator cannot reach (the agent instance, or its own); Askar's `adminAccount` only for provisioning. The restore drills already exist — re-run them after the role change. Test: `psql` as each role against another database → permission denied.
**Added by Phase 6:** the `biometric` database (biometric-service) also lives on `agent-postgres` and connects as `postgres`. It needs its own role like the others. Revisit a dedicated instance only if production moves to instance-level backups or the role split cannot isolate it (`15-phase-6-biometric.md`).
**Status (2026-09-22): done on staging** ([`infra/runbooks/postgres-roles.md`](../infra/runbooks/postgres-roles.md); evidence in `4-init-post-phase-0.md` §10 Phase 7; the rollout found trap 49, the Askar schema per user).
- **Owner decision: no dedicated instance.** The endorser store moves to `agent-postgres`, owned by `endorser_service`.
- Roles, each owning only its own databases: `agent_service`, `endorser_service`, `platform_api`, `console`, `biometric` on agent-postgres; `mediator` on the mediator instance. `platform_ro` is unchanged.
- The exporters use `monitoring_ro`. They also connected as `postgres`, which the review missed.
- `infra/scripts/pg-roles.sh` does all of this idempotently. It revokes `PUBLIC` connect and transfers every schema, table, sequence, type and function.
- The Askar root store's admin account appears only on `agent-provision`.
- Tested on scratch Postgres 15:
  - Every cross-database connection was refused.
  - Owners could migrate.
  - `platform_ro` was limited to its three columns, and `monitoring_ro` could read only.
  - The endorser dump-and-restore move worked.
  - A second run changed nothing.

### L9 · Low · Askar pool size
**Phase 9 W4 (2026-10-04): verified under load on staging.** 30 concurrent exchanges over 300 polling wallets used 10 connections to `agent_root` (Askar's default) and never ran short; `ASKAR_MAX_CONNECTIONS` exists now but stays unset. The concurrency switch gave no throughput gain and a worse tail, so it stays off (`19-phase-9-production-findings.md` W4 A4).

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
**Re-validated 2026-09-22:** confirmed. H3's new role passwords are env vars too.
- **Achievable:**
  - our services and the console read `*_FILE`;
  - Postgres takes `POSTGRES_PASSWORD_FILE`.
- **The limit:** the third-party mediator image reads only env vars. A wrapper that reads the files and then `exec`s keeps them out of `docker inspect`, but not out of that process's `/proc/<pid>/environ`. Accept this and document it.
- **The pass condition stays:** `docker inspect` shows no secret values for any container.

**Status (2026-09-23): kept open by owner decision.** It moves to the production host, where the choice belongs with M13 (backups) and M17 (CI and tags). The trade-off that has to be settled there:
- **Files on disk** (root-only, e.g. `/opt/12id/run-secrets`): the VM still restarts its containers unattended after a reboot, and the values leave `docker inspect` and Docker's own on-disk config. A decrypted copy then lives on the disk, like the age key already does.
- **Files on tmpfs:** nothing decrypted at rest, but a reboot leaves every container crash-looping until an operator runs the deploy script.
- Either way the mediator is third-party and reads only env vars: a wrapper keeps its values out of `docker inspect`, not out of its own `/proc/<pid>/environ`.

**Status (2026-09-29): done on staging (Phase 9 W2, owner decision "files on disk").**
- **How it works:** `deploy.sh` writes each mounted secret to `/opt/12id/run-secrets/<stack>/<KEY>`: the directory is root 0700, each file `root:12000 0440`, and the reading containers run with `group_add: 12000`.
  - Services and console read `NAME_FILE`, and a database password arrives as `NAME_URL_PASSWORD_FILE` (`credo-base/src/file-env.ts`).
  - The mediator has an entrypoint wrapper.
  - Postgres, Grafana, the exporters and Alertmanager read their files natively.
- **Evidence:** `check-inspect-clean.sh` found 88 exposures in 34 containers before and **0 of 32 values in 35 containers** after. Every smoke passed. Details: `19-phase-9-production-findings.md` W2.

### M13 · Medium · Backups on the VM, one age recipient
**Where:** `infra/scripts/backup-postgres.sh:12,23` (`KEEP_DAYS` rotation, VM-local), `.sops.yaml` (single recipient), the owner item "back up the age key" (Appendix A).
**Impact:** disk loss or a mis-typed `rm` takes the data and the only key that decrypts the backups; the script's own header calls this "not a production pattern".
**Fix:** a second age recipient (operator's offline key) on both SOPS and backups; nightly copy to object storage in another provider/region; a restore drill from the off-site copy. Owner decision on where.
**Re-validated 2026-09-22 — kept open (owner decision: off-site backups come later).** Nothing has changed:
- Backups go to `/opt/12id/backups` nightly at 02:30 UTC and are kept 7 days (`backup-postgres.sh:16-18`).
- They are encrypted to the only age key, `/opt/12id/secrets/age.key`, which is on the same VM (`6-phase-1-findings.md` §W9).
- Recommended in the meantime: copy the age key somewhere safe off the VM. It costs nothing.

**Status (2026-09-29): done on staging (Phase 9 W2).** The owner chose a backup machine at another site that pulls, instead of object storage.
- **Built:**
  - A second, offline age recipient in `.sops.yaml` and in every backup file.
  - Atomic backup directories.
  - `backup-pull.sh`: `rrsync -ro`, 30 daily + 12 monthly copies.
  - Production also backs up the validators' volumes and the genesis.
- **Evidence:**
  - A pull from another machine: its key can't run commands, write, or leave `/opt/12id/backups`.
  - A restore of the pulled copy **with the offline key only**: counts equal to live.
- **Still an owner action:** the real backup machine, and moving the staging offline key to offline storage. Details: `19-phase-9-production-findings.md` W2.4.

### M16 · Medium · Alert coverage
**Where:** `infra/staging/monitoring/alerts.yml` — 14 alerts, all infrastructure-level (targets, TLS, ledger, mediator queue, disk, memory, restarts).
**Missing:** `webhook_deliveries` dead count rising; outbox lag (`max(outbox.id) − outbox_cursor.last_id`); endorser `allowed = false` rate; platform-api / agent-service 5xx rate; mediator `DidcommOutOfBand` and `DidcommMediation` record growth (the open-relay signal beyond the spike alert); idempotency table size. Alert e-mail still needs the app password (owner). Fix: the postgres-exporter custom queries already exist (`monitoring/postgres-exporter-queries.yml`) — add these and their rules; fire each once deliberately (Phase 1 item still open).
**Re-validated 2026-09-22:** partly changed.
- There are 19 rules now (Phase 6 added the biometric ones), and Alertmanager's SMTP reads `/run/smtp/password`. The owner still has to confirm that mail actually arrives.
- The application alerts are still missing.
- **No service exposes `/metrics`.** So:
  - the 5xx-rate alert comes from Caddy's metrics (`caddy_http_requests_total` by code);
  - dead letters, outbox lag, OOB growth and endorser refusals come from SQL in `postgres-exporter-queries.yml`.

**Status (2026-09-23): done on staging. 26 rules, 22 targets, all up.**
- **New metric sources:**
  - Caddy's own per-server metrics (the `servers { metrics }` global option), scraped from the admin endpoint: status codes at the edge;
  - `postgres-exporter-agent` (9190, `agent_service`): outbox backlog and the age of the oldest unacknowledged row, which is exactly the consumer's lag;
  - `postgres-exporter-endorser` (9191, `endorser_service`): decisions in 24 h by outcome, and the busiest tenant's ledger writes (pressure against M3's ceiling);
  - the platform exporter gained webhook deliveries by status with the oldest age, wallet counts (including never-connected, review M10) and the idempotency table size;
  - the drizzle exporter gained `DidcommOutOfBand` / `DidcommMediation` / `DidcommConnection` counts.
- `pg-roles.sh` grants `monitoring_ro` read access to those tables (it is still read-only).
- **New alerts:** `WebhookDeadLetters`, `WebhookBacklogStuck`, `OutboxLag`, `EndorserRefusals`, `EdgeServerErrors`, `MediatorOutOfBandGrowth`, `IdempotencyKeysGrowing`.
- **Each was fired deliberately** (thresholds temporarily replaced by an always-true expression): all 7 reached Prometheus and Alertmanager, which mails the ops address. The real thresholds were restored, and nothing is firing now.
- **Owner:** confirm the seven `[FIRING]` mails (and their `[RESOLVED]` pairs) arrived at onetwoidadmin@gmail.com.
- **Found on the way:** a single-file bind mount again (trap 50). A changed exporter query file needs `--force-recreate`, not just `up -d`.

### M17 · Medium · Mutable tags, drifted stacks, no CI
**Where:** `compose.agent.yml` `12id/services:phase3` vs `compose.platform.yml` `12id/services:phase4` (same Dockerfile, different builds); `postgres:15-alpine`, `valkey/valkey:8-alpine`, `node:22-alpine` (webhook-sink) unpinned; `nazihar/12id` has no `.github/`.
**Impact:** "what is running" cannot be answered from the repo; a `docker compose pull` can move a database major silently; every gate in this file was run by hand.
**Fix:** tag images by git SHA and deploy both stacks from the same one; pin base images by digest; 5b.3 CI (PR: typecheck + tests + `npm audit --audit-level=high` + `check:client` + SDK `apiCheck`; tag: build, push, `services/VERSIONS.md`).
**Re-validated 2026-09-22 — partly fixed, the rest kept open.**
- **Fixed by the H2/H3 rollout:** the agent, platform and biometric stacks all run `12id/services:phase7`, so they no longer drift apart.
- **Still true:**
  - tags are mutable;
  - the console runs `phase6`, and its tools image `phase4-tools`;
  - the base images are unpinned;
  - there is no CI.
- **Correction:** "a `docker compose pull` can move a database major silently" is wrong. `postgres:15-alpine` stays on 15 and `valkey/valkey:8-alpine` stays on 8; only patch releases change.
- **Owner decision:** kept open until the publishing phase (tag policy, digest pins, CI with 5b.3), with production images built fresh then. Until then, staging deploys every stack from one build per step.

**Status (2026-09-29): tags and pins done (Phase 9 W2); CI stays with W3.**
- The deploy compose files have no `build:`. Every image is `${REGISTRY}/12id-<name>:${VERSION}@${DIGEST}` from `infra/compose/release.env`, which `infra/scripts/release.sh build|tag` writes.
- Every third-party and base image is pinned by digest.
- Staging runs one version, `sha-f4d1849-dirty`, from GHCR for all nine images.
- That build ran on the staging VM once, by owner decision, because the dev PC's disk was full. CI (W3) takes over building.

### M18 · Medium · The mediator's databases have no secondary indexes
*Phase 9 W4 (2026-10-04): the list missed `Did.alternative_dids`. DidRepository's lookup `(alternative_dids @> $2 OR did = $3)` scanned all of `Did` on every poll (88 ms at 6k rows), and the mediator timed out from 1k wallets. `12id_did_alternative_dids_gin` fixes it (0.17 ms).*

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
**Re-validated 2026-09-22:** the finding is confirmed, but the fix can't go in `Dockerfile.migrate`:
- The `migrate` container (`compose.mediator.yml:118-131`) is the mediator image with pnpm, and it has no `psql`.
- `queued_message` lives in `message_pickup`, which the mediator creates on its first start, after `migrate` has run.

**Corrected fix:**
- Put the list in `infra/staging/mediator/indexes.sql`, using `create index concurrently if not exists`.
- A one-shot `mediator-indexes` service (`postgres:15-alpine`, role `mediator`) runs it with `depends_on: mediator-1: service_healthy`.
- `conn_oob_idx` also serves M10's never-connected check.

**Status (2026-09-22): done on staging. Indexes alone would not have worked.**
- **What the review missed.** Statement logging on staging showed every array/jsonb lookup written by drizzle-storage 0.6.0 as `to_jsonb(column) @> to_jsonb(array[…])`. `to_jsonb` is STABLE, not IMMUTABLE: it cannot be indexed, and a plain GIN index on the column is never used for it. The hottest query of all has that form: the `Did` lookup by recipient-key fingerprint, run for every inbound message and every 10 s poll.
- **Fix, part 1: mediator image `-p4`.** `patch/queryToDrizzlePostgres.mjs` (`arrayContainsAll`) emits native `column @> $n` for jsonb and array columns, encoded by the column itself. The meaning is the same.
- **Fix, part 2: indexes.** `infra/staging/mediator/indexes.sql` holds 12 indexes on `drizzle` and 2 on `message_pickup`. They are GIN on the containment columns, plus btree on the equality lookups: connection by DID, by `out_of_band_id` and by `id`; mediation by connection; out-of-band invitation by thread and by `@id`. The one-shot `mediator-indexes` service applies them with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` as the `mediator` role.
- **Evidence:**
  - **Scratch copy of the staging schema with 10,000 synthetic wallets:**

    | Query | Before | After |
    |---|---|---|
    | `Did` fingerprint lookup | 12 ms, seq scan even with the GIN index | 0.086 ms, bitmap index scan |
    | mediation by recipient key | 11 ms | 0.06 ms |
    | connection, mediation, platform `out_of_band_id` lookups | 0.7–3 ms, seq scan | 0.06–0.15 ms, index scan |

  - **Staging:** all 14 indexes exist, and both replicas rolled to `-p4` one at a time. A statement capture during `smoke:platform-credo` (PASSED) showed **0** `to_jsonb` forms and 264 native containment lookups. With seq scan disabled, the planner uses `12id_did_recipient_key_fingerprints_gin`; the staging tables are too small for it to choose the index on cost.
- **Left:**
  - file the `to_jsonb` form upstream with the queue bug;
  - re-check the patch on any drizzle-storage upgrade;
  - the Phase 8 load test measures the real profile.

### L1 · Low · Header hygiene
*run*: `X-Powered-By: Express` on `agent.` and `mediator.`; HSTS `max-age=31536000` without `includeSubDomains`/`preload`; `Server: Caddy` on `genesis.` 404s. Fix: `header -X-Powered-By` in the `hardening` snippet; `Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"` (every subdomain is TLS already); `handle_errors` on genesis.

**Status (2026-09-28): done on staging.**
- **Built:** the header block is now a `security_headers` snippet with the full HSTS value and `-X-Powered-By`. `hardening` imports it and adds a `handle_errors` block that imports it again and answers `"{err.status_code} {err.status_text}"` with the same status.
- **Why every site, not only genesis:** every error Caddy produces itself skips a site's `header` directive, not only the file-server 404. That includes the smoke issuer's 502 with no listener, a 413 from the M1 body cap, and a 429 from the rate limiter.
- **Checked first on the staging Caddy image, in a throwaway container on a loopback port:** 404, 502, 413 and 429 keep their status, and the 429 keeps its `Retry-After: 60`. `Server` and an upstream's `X-Powered-By` were gone from all of them.
  - One trap in that test: `respond` sorts before `rate_limit` in Caddy's directive order, so a limiter in front of `respond` never runs. The real sites proxy, so they are not affected.
- **Staging probes from the internet:** agent `/readyz` 200, mediator `/health` 202, genesis 404, `api` `/v1/ledger` 200, console `/login` 200, smoke-issuer 502, agent junk POST 500. All carry `max-age=31536000; includeSubDomains; preload`, and none carries `Server` or `X-Powered-By`.
- `preload` has no effect until someone submits the apex to the browsers' preload list. For `12id.com` that is an owner decision, because it binds the marketing site too.

### L2 · Low · Grafana and the ledger browser are public
Grafana has its own login and rate limit; the von-network browser exposes `/status` (node versions, uptime) and all ledger reads. Both are staging-only components, but they will be copied to production unless the runbook says otherwise. Fix: `basic_auth` or an IP allowlist in Caddy for both; production should have neither.

**Status (2026-09-29): closed for production by construction (Phase 9 W2).**
- The shared Caddyfile (`infra/compose/caddy/Caddyfile`) has no ledger browser and no Grafana site.
- Staging adds them from `infra/env/staging/caddy/staging.caddy`, and `infra/env/production/caddy/` is empty.
- Production reaches Grafana over an SSH tunnel (`GRAFANA_ROOT_URL=http://127.0.0.1:3300`) and runs no ledger browser.
- Staging is unchanged (public, behind Grafana's own login), as before.

### L16 · Low · The staging ledger's trustee seed is public (added 2026-09-28)
**Where:** von-network. `phase0/von-network/bin/von_generate_transactions:98` runs `generate_indy_pool_transactions`, which uses fixed test seeds. `manage:922` defaults `LEDGER_SEED` to `000000000000000000000000Trustee1`, and `docs/AddNewNode.md:825` publishes it with DID `V4SGRU86Z58d6TV7PBUe6f`. The client ports 9702–9708 are open to the internet by design, because phones read the ledger.
**Evidence:** *source read* (2026-09-28, while planning Phase 9). Not exercised against staging.
**Impact:** anyone can sign ledger writes as Trustee on staging: create stewards and endorsers, publish schemas and credential definitions under any DID, change the pool configuration. It affects staging data only. It rules von-network out for production.
**Fix:** production runs its own `indy-node-container` network, set up by a genesis ceremony (random seeds, trustee keys offline): [`18-phase-9-production.md`](18-phase-9-production.md) W2.5, `4-init-post-phase-0.md` §12.1. Staging can move to the same tooling after production is up (owner call).

**Status (2026-09-29): the production ledger stack is built and rehearsed (Phase 9 W2).**
- Built: `compose.ledger-nodes.yml`, the ceremony (random seeds, never printed, custody as age files), a trustee-signed endorser bootstrap, and a write probe on a role-less DID.
- Rehearsed as a scratch project on staging, including stopping 1 and then 2 of the 4 validators (`19-phase-9-production-findings.md` W2.5).
- Staging still runs von-network, so L16 stays open for staging only.

### L6 · Low · The open startup invitation still exists
`compose.mediator.yml` `CREATE_NEW_INVITATION: "false"` reuses a **multi-use open-mediation** invitation the image prints at startup; `/invite` is blocked at the edge but the URL is in every replica's log. Fix: patch `index.js` to skip invitation creation when `ADMIN_API_TOKEN` is set, or accept it and restrict log access.

**Re-validated 2026-09-28:** confirmed, and skipping the creation is not enough. The invitation already in the logs stays valid: an OOB record never expires, and the M10 sweep deliberately skips reusable ones. Staging had **two** of them, because both replicas created one within 30 ms on the first start (2026-09-13). 24 connections, all from that day, were made through them.

**Status (2026-09-28): done on staging (mediator `-p6`).**
- **Built:** `mediator/patch/index.js` is the image's built `index.js` with one branch added. With `ADMIN_API_TOKEN` set (the platform's per-wallet route), it creates and logs no invitation and deletes every reusable open invitation. Without the token it behaves as upstream.
  - Connections already made keep their records and stay mediated: Credo needs an OOB record only while a handshake is running.
- **Tools:** `infra/scripts/mediator-invitation.sh` mints a single-use invitation through `POST /admin/invitations` on the VM, for `smoke-credo` and `MEDIATOR_INVITATION_FILE`. The token goes to curl on stdin. The M10 sweep deletes an unused one after 24 h.
- **Rollout:** the two rows were saved first, to `~/l6-reusable-oob-2026-09-28.csv` (mode 600) on the VM. The replicas then rolled one at a time.
- **Evidence:**
  - mediator-1 logged "retired 2 reusable invitation(s)" and mediator-2 "retired 0". Neither log contains an invitation URL.
  - Loopback `/invite?_oobid=<old id>` now answers 400 (no such invitation).
  - The 24 old connections still have their 24 mediations. A minted invitation works.
  - `smoke:platform-credo` PASSED and `smoke:biometric-credo` passed 18/18. Both mediate through single-use invitations.

### L7 · Low · `webhook-sink` in the stack
`compose.mediator.yml:167-177` — an unauthenticated HTTP sink that logs whatever it receives; only a debugging aid. Move it to `profiles: [debug]`.

**Status (2026-09-28): done on staging.** `profiles: [debug]` and `restart: 'no'`. The comment gives the command to start it on request (`deploy.sh mediator --profile debug up -d webhook-sink`). The running container was removed with `--profile debug rm -sf webhook-sink`, and `compose ps` now lists only postgres, valkey and the two replicas.

### I2 · Info · Rate-limit exemption for `10.0.0.0/8`
`Caddyfile:19` exempts the provider gateway hairpin; on a provider where other tenants share `10.0.0.0/8` this exempts them too. Narrow to `10.1.1.1/32` (the address the comment names).

**Status (2026-09-28): done on staging.** The exemption is `10.1.1.1/32 127.0.0.1/8`, and the comment says another host sets its own gateway (W2 moves it to the per-environment config). Every smoke and the console e2e passed afterwards, and Caddy's metrics showed **0** series with status 429. So all the VM's own traffic to the edge does arrive from `10.1.1.1`.

### Strengths (keep)
Loopback-only port publishing; `DOCKER-USER` drops on the node-to-node ports (`ufw/after.rules.docker-user`); `/register`, `/invite`, `/admin/*`, `/internal/*` and the console header refused at the edge (probed); SOPS+age with tmpfs decrypt, `shred`, `umask 077`; migration health-checked by table presence; staggered replica start; timing-safe compare in the mediator patch (`patch/agent.js:102-104`); nightly encrypted backups with restore drills for every database; ledger write probe; TLS expiry alert; both Node images non-root.

---

## 5. Findings — Track 4: console

### M12 · Medium · CSP without `script-src`
**Where:** `Caddyfile` apex block: `Content-Security-Policy "frame-ancestors 'none'"`; `console/src/start.ts:17-22` sets nosniff / referrer / frame headers, no CSP.
**Impact:** an XSS in any console dependency, or a crafted tenant name rendered unsafely, runs with the operator's session — every tenant's console scope.
**Fix:** a per-request nonce in `securityHeaders` (`default-src 'self'; script-src 'nonce-…' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`) passed to TanStack Start's script tags; drop the Caddy CSP once the app sets it. Test: a Playwright staging spec that fails on a CSP violation.
**Re-validated 2026-09-22:** confirmed (`console/src/start.ts:17-22`, `Caddyfile:148`). **Feasibility checked:** the installed router (Start 1.168.54) applies `router.options.ssr.nonce` to its inline scripts (`@tanstack/react-router/dist/esm/ssr/renderRouterToStream.js:25,76`). So the per-request nonce goes to `ssr.nonce` in the per-request `getRouter`.

**Status (2026-09-22): done on staging.**
- **`console/src/start.ts`:** the `securityHeaders` request middleware creates a 16-byte nonce per request and sends `default-src 'self'; script-src 'nonce-…' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. It passes the nonce on as request context.
- **Router:** `router.tsx` reads it through `getGlobalStartContext()` into `ssr.nonce`. The read is guarded for router builds outside a request.
- **One more inline script:** the Playwright guard found that next-themes' pre-paint theme script had no nonce. `__root.tsx` now passes it `nonce`.
- **Dev mode:** the header is not sent under `vite dev`, which injects unnonced scripts.
- **Edge:** the Caddy apex no longer sets `frame-ancestors 'none'`, because Caddy's `header` would replace the app's policy. The Caddy container was recreated (trap 50).
- **Test:** `console/e2e/csp.ts` is an automatic fixture. Every staging spec fails on any CSP report from any page, the owner's second browser context included.
- **Evidence:**
  - Vitest 23/23 (a new policy test), `tsc`, build and `check:client` clean;
  - one CSP header, with a fresh nonce on every request;
  - all 5 script tags and the modulepreload link on `/login` carry the nonce;
  - `e2e:staging` 3/3 with **zero** CSP violations. The first run failed on the next-themes script, which shows the guard works.

### L11 · Low · Session lifetime
`auth.server.ts:56-59`: 7 d sliding for everyone; `middleware.ts:19` caps operators at 12 h. Consider 24 h for tenant members (they manage API keys and webhook URLs).

**Owner decision (2026-09-28): shorten it.** Seven days is a security concern. This replaces the Phase 4 decision "members 7 days with 24 h refresh".

**Status (2026-09-28): done on staging.**
- **Rule:** every console session ends **24 h after sign-in** and is not extended by activity. Operators keep their 12 h.
- **Why a fixed cap and not a sliding one:** a sliding 24 h would keep a daily user signed in for ever.
- **Built:**
  - `lib/permissions.ts` `sessionExpired(role, createdAt)` replaces `operatorSessionExpired`: 12 h for operators, 24 h for everyone else, measured from sign-in.
  - `authMiddleware` checks it on every server function; before, only `operatorMiddleware` did. `getViewer` checks it for the route guards.
  - Better Auth: `expiresIn` 24 h with `disableSessionRefresh`, so the cookie and the row expire with the cap.
  - Checking the cap per request, not only through Better Auth's expiry, also cuts sessions that were issued under the old 7-day setting.
- **Trusted devices:** the console never sends `trustDevice`, so no trust cookie is ever set, and every sign-in asks for the second factor.
- **Evidence:**
  - console `tsc`, Vitest 32/32 (a new cap test, including a 6-day-old session), build and `check:client` clean;
  - staging `e2e:staging` 3/3 on the new build;
  - the 4 sessions the run created have a lifetime of exactly 24 h;
  - 36 older sessions that were still valid under the old rule are now refused, so their users sign in again.

### Strengths (keep)
A branded `Principal` only the middleware can create; the tenant resolved from the **session's active organization**, never from input (`middleware.ts:88-91`, `platform.server.ts:41-45`); invite-only, 2FA mandatory, operators TOTP-only with the after-hook (`auth.server.ts:66-74`); `disableSignUp`, `minPasswordLength 12`, `revokeSessionsOnPasswordReset`, hashed OTPs; CSRF middleware registered explicitly with the public origin (`start.ts:32-35`); `check-client-bundle.ts` refuses a client bundle containing `x-console-token`; the console reaches platform-api only through the console scope, audited per call; `Cache-Control: no-store` on authenticated server functions.

---

## 6. Findings — Track 5: Android SDK

### M14 · Medium · DEBUG forwarding and `http://` base URL
**Where:** `sdk-android/sdk/src/main/java/org/slf4j/impl/StaticLoggerBinder.kt:102` `isDebugEnabled = SdkLog.sink != null`; framework DEBUG lines include `Proof request json:` (`ariesframework/…/proofs/ProofCommand.kt:148`), `Connection record: {…}` (`connection/ConnectionService.kt:303` — DIDs, DID documents, the invitation), `Parsed Peer DID JSON` (`PeerDIDService.kt:88`); `OneTwoIdConfig.kt` accepts any `apiBaseUrl`; the sample writes the sink to Logcat.
**Impact:** an integrator who wires `logSink` to a crash reporter (the obvious thing to do) ships DIDComm internals and proof-request contents to a third party; a typo `http://` base URL sends the wallet token in clear on API 24–27 (cleartext is only blocked by default from API 28).
**Fix:** `OneTwoIdConfig(minLogLevel = Info)` and never forward framework DEBUG unless the host opts in; refuse a non-`https` base URL outside debuggable builds; document both in `docs/integration.md`. Test: JVM test that a Debug line does not reach a sink configured at Info.
**Re-validated 2026-09-22:** confirmed.
- `StaticLoggerBinder.kt:102-123`: every level is enabled whenever a sink is set.
- `OneTwoIdConfig.kt` does not check `apiBaseUrl`.
- Adding `minLogLevel` changes the public API, so run `apiDump`.

**Status (2026-09-22): done (SDK code; not on a device).**
- `OneTwoIdConfig(minLogLevel = LogLevel.Info)` by default. `SdkLog.enabled()` is the one floor, and the slf4j binding's `is*Enabled` asks it, so the framework itself stops formatting debug lines.
- `internal/ApiBaseUrl.kt`: `initialize` refuses a non-https `apiBaseUrl` with the new `OneTwoIdException.InvalidConfiguration`, unless the app is debuggable (`FLAG_DEBUGGABLE`), where `http://` is allowed for a local platform API.
- `docs/integration.md` documents both, and the sample shows the opt-in commented out.
- **Evidence:** `:sdk:testDebugUnitTest` 44/44, including a test that a framework debug line does not reach a sink at Info and that the binding reports `isDebugEnabled = false`; `apiDump` + `apiCheck` green with the new constructor parameter and exception.
- **Not run:** the phone smoke (`smoke:sdk-android`), which needs the device.

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

**Status (2026-09-28): done on staging.**
- endorser-service had the same hard-coded `false` (`agent/endorser-agent.ts`).
- Both now read `INDY_NETWORK_PRODUCTION` (a boolean, default `false`), which `compose.agent.yml` sets to `"false"` for the von-network ledger. Production sets `true` (Phase 9 W5).
- The agent-service config test covers the default, `true` and a refused value.
- On staging, both recreated containers show `false`.

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
  - **Done on staging 2026-09-28.** `compose.mediator.yml` runs `allkeys-lru`, and the comment now says why. Only Valkey was recreated (`--no-deps`). `valkey-cli config get maxmemory-policy` returns `allkeys-lru`, with 1 MB in use.
- **L14, done on staging 2026-09-28.**
  - The cache lives in platform-api's `agent-client.ts`, not in the routes. `listCatalogue` keeps each tenant's catalogue for `CATALOGUE_CACHE_MS` (30 s; 0 turns it off). Concurrent readers share one request, and a failed read is not kept.
  - `publishSchema`, `publishCredentialDefinition` and `setSchemaDeprecated` go through the same client. They clear the tenant's entry whether they succeed or fail, because a timed-out publish may still land.
  - A second replica would see another replica's change after at most 30 s.
  - Tests: `agent-client.test.ts`, 3 cases.
  - On staging, `smoke:platform-credo` made **one** `GET …/catalogue` for its offer and proof request together, where there used to be one each. The offer found the credential definition the smoke had published seconds before, which shows the publish cleared the entry.
- **L15, done on staging 2026-09-28.** `GET /v1/ledger` sends `Cache-Control: public, max-age=300` (the app test checks it). `curl -I` from the internet shows it.
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
| 1 | ✅ **Done 2026-09-22.** H2 + H3: per-hop tokens, endorser network, per-service DB roles, endorser store off the mediator instance (to agent-postgres, no new instance) | container-to-container probes fail; `psql` cross-database denied; restore drill re-run. **Passed on staging:**
- probes: `ENOTFOUND` from every service except agent-service
- cross-database access denied
- restore drill passed
- smokes: biometric 18/18, platform-credo, console 3/3 |
| 2 | ✅ **Done 2026-09-22.** K1: setup routes console only (added 2026-09-22) | API key → 403 on every moved route, console → 2xx; smokes on console headers. **Passed:** staging probe 403/200, `e2e:staging` 3/3, `smoke:platform-credo` |
| 3 | ✅ **Done 2026-09-22.** M5: internal-API timeout fix (per-call client timeout; async cred-def later) | 15 s handler test; `smoke:platform-credo`. **Passed:** 11 s silent-handler test (fails on the old code), `smoke:platform-credo` |
| 4 | ✅ **Done 2026-09-22.** M2 + M6 + M8 + M9: fair-share dispatcher concurrency, replay-safe consumer (deterministic event id), live URL, secret overlap with multi-`v1` verify | dispatcher + consumer + signer unit tests. **Passed:** 66/66, `smoke:platform-credo`, `smoke:biometric-credo` 18/18 |
| 5 | ✅ **Done 2026-09-22.** M7: advisory-locked outbox insert | concurrent-insert test. **Passed:** `outbox-order.test.ts` (real Postgres), smokes above |
| 6 | ✅ **Done 2026-09-22.** M1: DIDComm body cap on agent **and mediator** (per-IP only after reading logs) | staging probe 413 on both. **Passed:** 413 on both, WebSocket 1009, `smoke:platform-credo` |
| 7 | ✅ **Done 2026-09-29 (Phase 9 W2).** M11: file-based secrets (mediator: `docker inspect` only); kept open by the owner 2026-09-23 until the production host | `docker inspect` clean. **Passed:** 0 of 32 secret values in 35 containers (88 exposures before) |
| 8 | ✅ **Done 2026-09-22.** M4 + M10 + M18: configurable per-principal rate limits; wallet / mediation / queue sweep (OOB-based "never connected", 30 d grace for revoked); mediator index service. ✅ **M18 done 2026-09-22** (drizzle-storage patch `-p4` + 14 indexes) | 429 probe; staging sweep run; `EXPLAIN` before/after on 10 k synthetic rows. **M18 passed:** 12 ms → 0.09 ms on 10 k wallets; 0 `to_jsonb` forms on staging. **M4/M10 passed:** invitation 429 probe; first sweep `connected: 4, revoked: 0` |
| 9 | ✅ **Done 2026-09-22.** M3: endorser daily ceiling (`ENDORSER_DAILY_CEILING`) | policy unit test. **Passed:** 32/32, count query checked on Postgres |
| 10 | ✅ **Done 2026-09-22.** M12: nonce CSP | Playwright CSP spec. **Passed:** `e2e:staging` 3/3 with the CSP guard, 0 violations |
| 11 | ✅ **Done 2026-09-22.** M14: SDK log floor + https check | JVM tests; `apiDump`. **Passed:** 44/44, `apiCheck` green. Phone smoke **passed 2026-09-30** (Phase 9 W2): no Debug or Verbose line in the app log |
| 12 | ✅ **Done 2026-09-23.** M16: application alerts (SQL + Caddy metrics) | each fired once. **Passed:** 7 new rules fired to Alertmanager and were restored; 26 rules, 22/22 targets up |
| 13 | ✅ **Done 2026-09-28.** H1: deletion routes + retention job + the §5.3 customer document (2–3 d); plus operator masking and flagged operator keys (owner) | staging issue → delete → grep every store. **Passed:** erase probe over the public API, 0 matches in platform rows and bodies, agent 404 for the Credo records, masked operator view with an audited reveal, `e2e:staging` 3/3, both smokes |
| 14 | ✅ **Done 2026-09-28.** L1, L4, L6, L7, L13, L14, L15, I1, I2 (L5 done with H1) | probes / unit tests; `valkey-cli config get maxmemory-policy` returns `allkeys-lru`; one agent-service call per offer instead of two; `curl -I /v1/ledger` shows `Cache-Control`. **Passed on staging:**
- all of the above, with one catalogue read for an offer and a proof request together;
- no `Server` or `X-Powered-By` on any host, error responses included;
- 400 for oversized attributes from the internet;
- mediator `-p6` retired both startup invitations;
- 0 responses with status 429 after I2;
- tests: platform-api 95/95, agent-service 59/59, endorser-service 32/32, credo-base 12/12;
- `smoke:platform-credo` PASSED, `smoke:biometric-credo` 18/18, `e2e:staging` 3/3 |

**Order revised 2026-09-22** after the re-validation: K1 added; M5 and the webhook bundle moved up; M7 and M16 given their own rows.

**Kept open by the owner, then done in Phase 9:** M13 off-site backups and a second age recipient (2026-09-22; done W2 2026-09-29); M17 tag policy, digest pins and CI (2026-09-22; pins W2, CI W3); M11 file-based secrets (2026-09-23; done W2 2026-09-29).

**Owner decisions (not code):** M16 confirm alert e-mail delivery; L2 whether Grafana and the ledger browser exist in production at all; L8 rotate the `.staging` credentials; §12.1 ledger topology, a clean production host, TAA (bucket C).

**Defer to their phases:** M15 with 5b.1, then with W5's production keys (the wrapper rebuild is done, W3); L9, M1's concurrency switch and M2's numbers with the Phase 8 load tests (done 2026-10-04, W4: L9 verified, concurrency off, M2 defaults unchanged); L10 and L11 done 2026-09-28 by owner decision; L3 in Phase 4 C9 (2026-09-24).

**Explicitly not doing:** sharing the mediator's Valkey with the other services, or adding Redis anywhere (§8). Build M4's rate limiter in-process behind a small store interface so it can move to Redis the day platform-api runs a second replica.

---

## 11. Document updates made with this review (2026-09-16)
- `4-init-post-phase-0.md` §0.1 and §10: pointer to this file; the review fix set is **Phase 6 — Pre-production hardening** and the former Phase 6 (load tests, failover, key rotation, DR) is now **Phase 7 — Hardening**.
- `15-next-step.md` removed; this file takes its number. Its Phase 5b recommendation (Android SDK release) is preserved in Appendix A and follows Phase 6.

**Renumbering (2026-09-21):** the biometric gate was inserted as **Phase 6** ([`15-phase-6-biometric.md`](15-phase-6-biometric.md)). This file was renamed from `15-phase-6.md` to `15-phase-7.md`, then to `17-phase-7.md` so the files run in phase order (Phase 6 plan `15`, findings `16`, Phase 7 review `17`); its fix set is now **Phase 7 — Pre-production hardening**, and Hardening is **Phase 8**. The references in the body were updated; the bullets above keep the numbering of their date. Appendix A (5b) now runs after Phase 7.

**Re-validation (2026-09-22):** every medium finding was re-read against the current source before building.
- The summary gains **K1** (owner decision: setup routes console only).
- Corrections noted under M1, M3, M5, M6, M7, M8, M9, M10, M11, M16, M17 and M18. The largest:
  - M6's proposed transaction cannot work;
  - M8's DELETE half is already handled, and the retry window is ~2.4 h, not a day;
  - M1 applies to the mediator too;
  - M18's index SQL cannot run in the migrate container.
- M13 and M17 are kept open by the owner.
- §10 re-ordered.
- The origin phase docs got dated back-notes for H2/H3; each medium fix adds its own when it lands.
- `4-init-post-phase-0.md` trap 44 corrected.

---

## Appendix A — Phase 5b: Android SDK release (carried over from the removed `15-next-step.md`)

Runs after Phase 7. It is the one item the design names as a first-customer blocker (§9 original: "resolve before the first customer integration"; §12.16): the SDK is local-Maven only, consumers need three repositories, the wrappers' x86_64 libraries do not load (no emulator testing, minSdk 24 unverified), and there is no CI.

**5b.1 Rebuild the UniFFI wrappers under our coordinates** (finding 9 / trap 42)
- Fork `LF-Decentralized-Trust-labs/aries-uniffi-wrappers`; build askar / anoncreds / indy-vdr for `arm64-v8a`, `armeabi-v7a`, `x86_64` (drop the four dead ABIs), linking compiler-rt builtins statically so `__extenddftf2` resolves on x86_64.
- Publish as `com.12id:askar-uniffi-android`, `anoncreds-uniffi-android`, `indy-vdr-uniffi-android`; replace the `org.hyperledger` coordinates in `sdk-android/ariesframework/build.gradle:53-55`; retire `scripts/mirror-uniffi.ps1` and `third_party/m2`.
- Acceptance: the sample onboards on x86_64 emulators at API 24, 26, 28 and 36 **and** still passes `smoke:sdk-android` on the phone. M15 (minisign on device) lands here, since the rebuild resets the size budget.

**5b.2 One repository for consumers**
- Vendor or shade `com.github.multiformats:java-multibase` (only JitPack has it) so `settings.gradle` needs no JitPack entry.
- ~~Decide the public repository~~ **decided 2026-09-30 (owner):** a static Maven repository on GitHub Pages at `maven.12id.com`. The fork is merged into the SDK artifact, and the wrappers become one `com.12id:holder-sdk-native` artifact. CI is driven by tags. Details are in [`18-phase-9-production.md`](18-phase-9-production.md) W3, which supersedes this appendix.
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
