# Phase 3 — Findings

**Plan:** [9-phase-3.md](9-phase-3.md). **Status: platform-api deployed on staging at `https://api.12id.naziharitsolution.com`; `smoke:platform-credo` PASSED end to end through the public API with signed webhooks and the wake path. `smoke:platform-android` (the gate) PASSED on the phone twice, the second time with a wake-up produced by the offline message itself. Phase 3 gate: passed.**

Code: `services/platform-api/` (28 tests, `tsc --noEmit` clean; `openapi.json` with 29 paths), agent-service additions (40 tests), mediator patch `-p2`, `infra/staging/compose.platform.yml`, `infra/smoke/platform-*.ts`, `infra/runbooks/platform-api.md`.

| Item | State |
|---|---|
| P0 agent-service additions | **done, deployed.** Internal token on the internal API (health routes open; `/tenants/x` → 401 without it), `GET /outbox` (2 s settle window) + `POST /outbox/ack`, `GET /tenants/:id`, `GET …/connections/:id`, credential detail with `credentialDefinitionId` + `attributes`. Fastify's own 4xx (e.g. empty JSON body) now map to 4xx instead of 500 |
| P1 mediator patch `-p2` | **done, deployed** on both replicas. `POST /admin/invitations` mints a single-use OOB invitation; disabled without `ADMIN_API_TOKEN`; 401 with a wrong token; **404 from the internet** (edge). Webhook URL now points at platform-api with a secret path |
| P2–P5 platform-api | **done, deployed.** 29 routes in four credential scopes; OpenAPI at `/openapi.json`; idempotency keys; per-wallet tokens and invitations; `/v1/ledger` public config |
| P6 outbox consumer | **done.** Caught up from cursor 0 to the head (48 rows, incl. Phase 2 rows for a tenant with no platform record → logged and skipped) within seconds of first start |
| P7 webhooks + wake path | **done, verified on staging** (below) |
| P8 OpenAPI + docs | `services/platform-api/openapi.json` committed; `GET /openapi.json` 200 from outside; integration guide `services/platform-api/docs/api.md` |
| P9 staging deploy | **done.** `platform_api` database on `agent-postgres`; `platform_ro` role with column-level SELECT on the mediator's `DidcommConnection`; Caddy site `api.<domain>`; blackbox probe; backups + restore drill; SIGTERM drain |
| P10 `smoke:platform-credo` | **PASSED** (2026-09-14 06:57Z) |
| P10 `smoke:platform-android` | **PASSED on the phone** (2026-09-14 07:14Z and 07:17Z), details below |

Every claim below comes from a run against staging on 2026-09-14 or a local test run.

---

## smoke:platform-credo — PASSED

Everything through `https://api.12id.naziharitsolution.com` with an API key; only the tenant + key were created over the admin tunnel (`platform-bootstrap.ts`). A Credo holder stood in for the SDK; a local webhook receiver behind `https://smoke-issuer.<domain>/webhook` verified every signature.

```
06:56:33.966Z webhook endpoint set
06:56:34.334Z schema FfUXZbrq4eKyBmLPyeVeuJ:2:smoke-badge:1.368993
06:56:37.703Z cred def FfUXZbrq4eKyBmLPyeVeuJ:3:CL:147:default
06:56:37.833Z wallet 856e301a-… got its mediator invitation
06:56:39.199Z holder mediated through the per-wallet invitation
06:56:40.333Z webhook wallet.sync_requested wallet 856e301a
06:56:43.382Z webhook connection.state_changed fe0f1305 request-received -> request-received
06:56:43.401Z webhook connection.state_changed fe0f1305 request-received -> response-sent
06:56:47.444Z webhook connection.state_changed fe0f1305 response-sent -> completed
06:56:47.827Z offered cc8e097f-… (offer-sent); idempotent replay ok
06:56:51.703Z webhook credential.state_changed cc8e097f · -> offer-sent
06:56:53.797Z webhook credential.state_changed cc8e097f offer-sent -> request-received
06:56:53.813Z webhook credential.state_changed cc8e097f request-received -> credential-issued
06:56:57.864Z webhook credential.state_changed cc8e097f credential-issued -> done
06:57:01.967Z webhook proof.state_changed 738663f4 · -> request-sent
06:57:03.053Z webhook proof.state_changed 738663f4 request-sent -> presentation-received
06:57:03.081Z webhook proof.state_changed 738663f4 presentation-received -> done
06:57:04.465Z proof done: verified=true disclosed={"employee":{"name":"Ada Lovelace (platform)","department":"Analytical Engines"}}
=== smoke:platform-credo results ===
connection webhook : completed externalId=credo-1789368993790
credential webhook : done replayed=true
proof webhook      : done verified=true
wake-ups           : 1
signatures         : all valid
deliveries pending : 0
=== smoke:platform-credo PASSED ===
```

**What this establishes (confirmed, run):**
- **Per-wallet mediator invitations work.** The mediator's patched route minted a single-use invitation; a holder obtained mediation through it (Credo holder over HTTP, Phase 1 W8 constraint). The mediator's connection record carries the `out_of_band_id`, and the platform mapped the mediator's first webhook for it to the wallet **before the holder had even connected to the issuer** (06:56:40: the queued mediation-grant/keylist replies triggered it).
- **The wake path end to end:** mediator `Notification sent successfully to <connectionId>` (5 across the two replicas in this window) → platform `/internal/mediator/<secret>` → one `wallet.sync_requested` (the remaining four fell inside the 30 s debounce window).
- **Webhooks:** 11 deliveries, all `delivered` on the first attempt, all signatures valid against the secret returned once by `PUT /v1/webhook`; `externalId` echoed on every event.
  > **Phase 7 update (2026-09-22, review M2, M6, M8, M9):**
  > - Deliveries now run in a fair-share pool, go to the endpoint's current URL, and carry two `v1` signatures for 24 h after a rotation. The smoke's receiver accepts any `v1`.
  > - Outbox events have derived ids, so a replay cannot duplicate them.
  > - `smoke:platform-credo` PASSED again on the new build with all signatures valid, and `smoke:biometric-credo` 18/18.
  > - Since review K1, the smoke sets the endpoint through the console client, not with the API key.
  > - See [`17-phase-7.md`](17-phase-7.md) M2, M6, M8, M9.
- **Idempotency:** the second `POST /v1/credentials/offer` with the same `Idempotency-Key` returned the stored 202 with `idempotent-replayed: true` and made no second agent call.
- **Templates:** `{ schemaName: "smoke-badge" }` expanded to the unqualified cred def id at request time; the automatic `expiresAt >=` predicate and a caller predicate (`employeeNumber > 1000`) verified together.
- **Latency through the platform:** offer → holder `done` 10 s; proof request → `done` 1.1 s; a webhook arrives 1–4 s after the Credo transition (outbox settle 2 s + 1 s polls).

## smoke:platform-android — PASSED (the Phase 3 gate)

Device: Xiaomi 2109119DI, Android 14. App: the Phase 0 sample (`PickUpV1`, staging genesis) rebuilt with the **per-wallet mediator invitation** minted by `GET /v1/wallet/mediator-invitation` (`WalletApp.kt`; the Phase 2 version is kept as `.phase2.bak`). Everything server-side went through the public API with an API key; every observation below came from signed webhooks.

Run 2 (wallet `462bcaa0…`, workstation clock):

```
07:16:34.495Z app launched with a fresh wallet
07:16:42.868Z webhook connection.state_changed ec637970 · -> request-received
07:16:43.915Z webhook connection.state_changed ec637970 response-sent -> completed   (theirLabel phase0-android-holder)
=== LIVE ===
07:16:44.944Z webhook wallet.sync_requested wallet 462bcaa0
07:16:47.977Z webhook credential.state_changed e8289f2e · -> offer-sent
07:16:55.119Z webhook credential.state_changed e8289f2e credential-issued -> done
=== OFFLINE ===
07:16:55.691Z app force-stopped
07:16:55.692Z waiting 32 s for the wake-up debounce window to close
07:17:27.856Z offer sent while the app was closed
07:17:28.247Z webhook wallet.sync_requested wallet 462bcaa0
07:17:33.524Z app reopened
07:17:40.512Z webhook credential.state_changed 123e0edb credential-issued -> done
=== PROOF ===
07:17:44.566Z webhook proof.state_changed ee4b665b · -> request-sent
07:17:49.683Z webhook proof.state_changed ee4b665b presentation-received -> done
live credential   : done
offline credential: done (7.2 s after reopen)
wake webhook      : received (total for this wallet: 2)
proof             : done verified=true {"employee":{"name":"Ada Lovelace (live)","department":"Analytical Engines"}}
signatures        : all valid
=== smoke:platform-android PASSED ===
```

**Server-side evidence (VM, run 2):** 3 mediator webhooks (2 on `mediator-1`, 1 on `mediator-2`) → 3 hits on the receiver → 2 `wallet.sync_requested` (one debounced); 0 queued rows left for the phone's mediator connection; 0 `invalid state` lines in agent-service (no duplicate presentations, the `-p1` queue patch holds); 0 platform-api error lines; every webhook delivery `delivered`.

**What this closes (confirmed, run):**
- **The native Kotlin holder mediates through a per-wallet single-use invitation** minted by the patched mediator; no change to the app beyond the invitation string.
- **The wake path with the native holder:** a message queued while the app was force-stopped produced `wallet.sync_requested` **0.4 s** after the offer, and the credential was collected 7.2 s after reopen (Phase 2: 3.1 s; the extra time is app start and the first poll, not the platform).
- **Platform mirror + webhooks are enough to drive the whole exchange**: the script never read agent-service; `theirLabel`, `invitationId`, `verified` and `disclosed` all arrived by webhook.
- **Template proofs with the automatic `expiresAt` predicate on the native holder**, via `{ credentialDefinitionId }`.

**Run 1** (wallet `ff2c93b3…`, 07:14Z) also passed, but its only wake-up came from the live offer; the offline offer 9 s later fell inside the 30 s debounce, and the script's "received" check wrongly matched the earlier event (index compared against a wake-up count instead of the event list). The script now waits out the debounce window before the offline step and requires a new wake-up; run 2 is the result above.

### A wiped app cannot reuse its invitation (confirmed, run, 07:23Z)

The app installed for run 2 still carried wallet `462bcaa0…`'s invitation, already used. `pm clear` + launch reproduces "the user lost the app's data":

```
app     13:23:04.413 Send outbound message of type did:sov:…;spec/connections/1.0/request to endpoint wss://mediator.12id…
mediator-2 07:23:04.916 Received message with type 'did:sov:…;spec/connections/1.0/request'
mediator-2 07:23:04.930 ERROR Error handling message … CredoError: Out-of-band record has been already processed and it does not accept any new requests
app     13:23:24.485 E phase0: openWallet failed: Connection to the mediator timed out.
                     at org.hyperledger.ariesframework.routing.MediationRecipient.initialize(MediationRecipient.kt:116)
```

- **The mediator refuses, and says nothing to the holder.** No problem report comes back, no connection or mediation record is created; the holder only learns from its own 20 s timeout. Same silent-failure shape as §11.11.
- **Consequence for Phase 5:** on a mediator-connection timeout at first init, the SDK must call `GET /v1/wallet/mediator-invitation` again and retry once with the new invitation. The platform side already supports that: a second call mints a new single-use invitation and replaces the wallet's `mediator_oob_id` (that path is what runs 1 and 2 used, so the recovery itself is covered). A timeout for any other reason (network) takes the same path at the cost of one unused invitation.
- The platform cannot tell the app "your invitation is spent"; the timeout is the only signal, so the retry must not depend on an error type.

Housekeeping: the three smoke API keys were revoked after the runs; the SSH tunnels were closed.

## Mediator patch `-p2` — verified

| Check | Result |
|---|---|
| `POST https://mediator.<domain>/admin/invitations` from the internet | **404** (edge) |
| Same route from platform-api (Docker network, token) | 200, `{ outOfBandId, invitationUrl }` |
| Both replicas after the roll | healthy; only the benign Askar "Duplicate entry" provisioning line |
| Startup invitation | unchanged; still only in logs. *Phase 7 update (2026-09-28, review L6): gone. Image `-p6` neither creates nor logs it while `ADMIN_API_TOKEN` is set, and deleted the two old ones; see [`17-phase-7.md`](17-phase-7.md) L6* |

The route is added to the built `apps/mediator/build/agent.js` after the `/invite` route (`infra/staging/mediator/patch/agent.js`, 23 lines). It uses the same `createInvitation` options as the startup invitation (`goalCode`, `goal`), with `multiUseInvitation: false`. There is no expiry on OOB records: an unused invitation stays valid on the mediator until used; the platform only hands each one out once and replaces it on the next call.

## Edge / exposure (from outside)

| URL | Result |
|---|---|
| `GET /v1/ledger`, `/openapi.json`, `/v1/health` | 200 |
| `GET /v1/connections` (no key) | 401 |
| `GET /admin/tenants`, `POST /internal/mediator/x` | 404 (Caddy) |
| `:3500` direct | closed |

## Deploy, drain, backup

- **Drain:** `docker stop platform-platform-api-1` → `drain started` … `drain complete` in 3 ms with `inFlight: 0`; healthy again 20 s after `up -d`.
- **Backup + restore drill:** `backup-postgres.sh` now dumps `platform_api` (29.6 kB encrypted); restored into a scratch `postgres:15-alpine` with `pg_restore --create`: 1 tenant, 2 wallets, 11 deliveries, `outbox_cursor.last_id = 48`.
- **Read-only role:** `platform_ro` has `SELECT (id, out_of_band_id, thread_id)` on `DidcommConnection` only (`information_schema.column_privileges`).
  > **Phase 7 update (2026-09-22, review H3):**
  > - `platform_ro` is unchanged and was re-verified to be limited to its three columns.
  > - platform-api itself no longer connects as `postgres`: the `platform_api` role owns only its database.
  > - See [`17-phase-7.md`](17-phase-7.md) H3 and [`infra/runbooks/postgres-roles.md`](../infra/runbooks/postgres-roles.md).
- **Monitoring:** `https://api.<domain>/v1/health` added to the blackbox targets; after a Prometheus restart `probe_success=1`, so `EndpointDown` covers it.

---

## Traps found while building

1. **Single-file bind mounts do not follow a replaced file.** The Caddyfile is bind-mounted as one file; extracting a tarball over it created a new inode, so `caddy reload` re-read the *old* file and the new `api.` site and `/admin/*` block silently did not exist (the mediator answered 401 for `/admin/invitations` from the internet, i.e. the request reached it). `deploy.sh edge up -d --force-recreate caddy` fixed it; certificates live in a volume. **Rule:** after syncing the Caddyfile, recreate the container, do not reload.
2. **A POST with `content-type: application/json` and no body is refused by Fastify** (`FST_ERR_CTP_EMPTY_JSON_BODY`). The agent client sent that for `POST /tenants/:id/onboard`, and agent-service's error handler turned the 400 into a 500 (it only recognised its own error classes). The first platform tenant landed in `failed`; `POST /admin/tenants/:id/onboard` recovered it after the fix. Both sides fixed: no content-type without a body; Fastify 4xx pass through.
3. **`node --test` runs files in parallel processes.** Database-backed suites truncated each other mid-run. platform-api runs with `--test-concurrency=1`.
4. **sops needs a matching creation rule or an explicit recipient** even for a temp file; `--filename-override <target path>` applies the repo's `.sops.yaml` rule to a file in `/dev/shm`. The VM had no `.sops.yaml` before Phase 3 (it is not under `infra/`).
5. **Fastify's `printRoutes()` splits path segments** (`c/redential/…`), so route-presence tests must match fragments like `outbox (GET`, not whole paths.
6. **A route registered with `app.register` at the end of a plugin works, but a text replace that silently misses leaves nothing registered.** The first staging deploy answered 404 on `/outbox` although the file existed; a route-presence test now guards it.

## Observations for later phases

- **The first `wallet.sync_requested` fires during mediation setup**, before the holder has any customer connection. Customers must treat it as "poll now", not "you have a credential". For a fresh install the SDK is already running, so this is harmless; the platform could suppress wake-ups until the wallet has at least one connection, but that hides real messages for multi-use kiosks. Left as is; documented.
- **Connection events include a `request-received -> request-received` transition** (Credo emits the first event with `previousState` equal to the state). Passed through verbatim.
- **PickUpV1 holders produce one mediator webhook per queued message while the app is open** (Phase 1 W5). With the 30 s debounce a busy wallet gets at most two wake-ups a minute; the Android run confirmed it (3 mediator webhooks → 2 wake-ups over 45 s).
- **Rate limits:** `api.<domain>` is behind the per-IP limit (600/min) only; no per-API-key limit yet.
