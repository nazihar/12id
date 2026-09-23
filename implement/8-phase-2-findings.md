# Phase 2 — Findings

**Plan:** [7-phase-2.md](7-phase-2.md). **Status: agent-service and endorser-service deployed on staging; tenant issuance and verification pass end to end over the internet with a Credo holder. `smoke:tenant-android` passed on the phone, after a mediator pickup-queue bug found by that run was patched. Open: the `ubuntu` password rotation (owner), filing the mediator bug upstream.**

Code: `services/` (credo-base, agent-service, endorser-service; 90 unit tests, `tsc --noEmit` clean), `infra/staging/compose.agent.yml`, `infra/smoke/tenant-credo.ts`.

| Item | State |
|---|---|
| T2 author/endorser on Credo 0.7.0 | **PASSED** (staging ledger, 2026-09-13) |
| T1 tenants on Postgres | **PASSED** (after one required config change: multi-context cache) |
| T3a hard kill + restart | **PASSED** (final run with the corrected check: store reopens, re-offer delivers, no store errors; stuck records accumulate) |
| T3b SIGTERM naive vs drain | **PASSED**: naive loses the in-flight message (2 of 2 runs); drain delivers it and closes cleanly |
| A0 credo-base | done: bindings, pino logger, pinned genesis, ID guards, Postgres store, multi-tenant cache; 10 tests |
| A1 agent factory | **done, run locally.** Config (zod), typed root agent, provision job (`store: provisioned`, 0 tenants), `main.ts`. Against local Postgres and the staging ledger: internal API `/healthz` 200 and `/readyz` 200 on :3410; DIDComm port :3400 serves `GET /readyz` 200 next to Credo's `POST /` (415 on the wrong content type). pino JSON logs, Credo lines tagged `component: credo` |
| A3/A4/A6 persistence | drizzle schema for `tenants` (onboarding state machine with resume fields), `ledger_objects` (both ID forms, author/endorsed requests, action-state cred def), `outbox`. Provision job creates the `agent_service` database if missing and applies migrations; run twice: `created` then `existing`, 3 tables, 1 migration. On the existing store Askar's benign duplicate now logs as level 50 `err.message: "Duplicate entry"`, which log alerting must ignore |
| A9 endorser-service | **runs locally.** Policy (17 tests) + Fastify API with shared-token auth, tenant→nym bindings (first bind wins), audit row for every decision, fail-closed when the audit write fails (28 tests total). Opens an existing endorser store only and refuses to start unless it holds `ENDORSER_DID`. Local run: dev endorser `did:indy:twelveid:staging:D2ZxkZeCbjKbdFX9yeHzqE` (throwaway, created via `scripts/dev-bootstrap-endorser.ts`; the staging endorser was not touched) |
| Bug found locally: SQL leak | Binding a nym already bound to another tenant returned **500 with drizzle's `Failed query: insert into "tenant_bindings" … params: …` in the response body**. Causes: (1) drizzle wraps the pg error, so `23505` is on `error.cause`, not `error.code`; (2) Fastify's default error handler returns `error.message`. Fixed with a shared `internalApiErrorHandler` (generic 500 body, full error logged) on both APIs plus `postgresErrorCode()` reading `cause`; regression tests in both services. **Re-probed after restart:** nym already bound to another tenant → `409 nym is bound to another tenant`; rebind to a different nym → `409 tenant is already bound to a different nym`; same binding again → `200 already_bound`. No SQL in any body |
| A3 tenant onboarding | **end to end on the staging ledger, 534 ms.** `pending → did_created → nym_endorsed → nym_written → ready` for tenant `584d5806…`, DID `did:indy:twelveid:staging:UmRpa6MPX6XDMqmmxhiCwB`. Endorser DB: binding `584d5806… → UmRpa6MPX6XDMqmmxhiCwB`, audit `nym | 1 | allowed`. Crash-resume at each step is not yet exercised |
| A4 catalogue | **end to end on the staging ledger, 3.4 s** for tenant `584d5806…` via the running endorser-service. Schema `UmRpa6MPX6XDMqmmxhiCwB:2:employee-badge:1.0` and cred def `UmRpa6MPX6XDMqmmxhiCwB:3:CL:59:default`, both `published` with qualified and unqualified ids stored; the cred def row keeps its action-state definition. Endorser audit: `nym 1`, `schema 101`, `credentialDefinition 102`, all allowed. Schema input requires `expiresAt` (5 tests). Observation: checking the ledger before submitting made Credo log level-50 `Error retrieving schema …` / `Error retrieving credential definition …` on every normal publish; the check now runs only after a failed submit. Re-run with `employee-badge 1.1`: published (`…:2:employee-badge:1.1`, `…:3:CL:62:default`) with **0 level-50/60 log lines** |
| A2 internal API | health/readiness plus command routes: tenants (create/onboard), schemas, credential definitions, invitations, connections, credential offer/status, proof request/result. Domain errors map to 400/404/409/422; everything else is a generic 500 |
| A5 exchanges | **PASSED locally, driven only through the internal API** (`spikes/src/a5-api-roundtrip.ts`): Credo holder behind the staging mediator; invitation → connection → v1 offer → `credential-issued`/`done` → v1 proof request with a caller predicate (`employeeNumber > 1000`) and the automatic `expiresAt >=` predicate → `isVerified: true`, disclosed `{ name, department }` returned by `GET /proofs/:id`. A qualified cred def id in a request → `400 … not in legacy unqualified form`. 0 warn/error lines in the service log |
| A6 outbox | every transition of the run written: connection ×3, credential ×4 (`offer-sent → request-received → credential-issued → done`), proof ×3 (`request-sent → presentation-received → done`), each with thread id and correlation id |
| A4 versioning | `POST /tenants/:id/schemas/:schemaObjectId/deprecation` flips a schema and its cred defs between `published` and `deprecated`; deprecated cred defs are refused by `offerCredential` (409) but stay valid in proof restrictions |
| T3a follow-up: reconciliation | `reconcileOnce` abandons issuer/verifier records waiting on the holder past a TTL (default 24 h, every 5 min) and writes the outbox row itself (`api.update()` emits no event). Verified locally: offer to a gone holder → `POST /admin/reconcile {ttlMs:1000}` → `abandoned: 1`, record `abandoned` with reason, outbox `offer-sent → abandoned` with the correlation id |
| **A10 staging deploy** | **done, 2026-09-13.** Image `12id/services:phase2` (641 MB) built on the VM; `compose.agent.yml` = agent-postgres, two provision jobs, endorser-service, agent-service; secrets `agent.sops.env`; Caddy site `agent.12id…` (POST `/` + GET `/readyz` only, rate-limited); blackbox probe; backups extended. First `deploy.sh agent up -d`: all healthy within 15 s, provision `store: provisioned`, `database: created` |
| **A11 staging smoke** | **PASSED.** Tenant `acme-staging` (`2e77894b…`) onboarded through the deployed services with the **real staging endorser** (`9WnS…`): DID `did:indy:twelveid:staging:UjjkD8KLZDxukp1MQvoZT2`, ledger role `null`; schema `…:2:employee-badge:1.0`, cred def `…:3:CL:67:default`. `smoke:tenant-credo` (`infra/smoke/tenant-credo.ts`, holder behind the staging mediator over `wss`, agent reached at `https://agent.12id…`): connected, credential issued, proof `isVerified: true`, disclosed attributes returned, qualified id → 400. Outbox: 10 rows, all with the correlation id. Endorser audit: `nym 1`, `schema 101`, `credentialDefinition 102`, all allowed; one binding. 0 warn/error lines in either service. Mediator logged 10 forwards from the agent. **Not run: `smoke:tenant-android`** (needs the phone) |
| **A11 `smoke:tenant-android`** | **PASSED on the phone** (Xiaomi 2109119DI, Android 14; Phase 0 sample app with `PickUpV1`, staging genesis and mediator; `infra/smoke/tenant-android.ts`, no Credo on the workstation). Tenant `acme-staging` on staging: connected via `connections/1.0` in 2 s; live credential `done` in 10 s; credential offered while force-stopped collected **3.1 s after reopen**; proof `done`, `isVerified: true`, disclosed `{ name, department }`, **with the mandatory `expiresAt >=` predicate** (so the Kotlin holder handles v1 predicates). Outbox: 14 rows, all with the correlation id. Two runs; see the mediator bug below for what the first one exposed |
| **Mediator bug found and patched** | The mediator's Postgres pickup queue **never deletes messages handed to a pickup-v1 holder**, so the native holder was re-sent every message on every 10 s poll, forever. Patched as an overlay image `12id/mediator:375518d-p1`; details below |
| A8 in the container | `docker stop agent-agent-service-1` (30 s grace): `drain started` … `idle: true`, `durationMs: 8`, exit 0, healthy again 15 s after `up -d`. No `Invalid resource handle` |
| A7 correlation | the platform's `correlationId` is on **all 10 rows** of an exchange, including the connection rows and the first `offer-sent`/`request-sent` (see trap below) |
| A8 drain | `InFlightTracker` + `createDrain` wired into `main.ts` on SIGTERM/SIGINT; 7 unit tests. Container SIGTERM test pending (A10/A11) |
| A2–A11 | not started; **all spike gates are now answered** |

**Rig:** Windows 11 workstation, Node 22.20.0, Docker Desktop 28.4.0.
- Local Postgres `postgres:15-alpine` on `127.0.0.1:55432`, container `12id-p2-postgres`.
- Staging ledger via the public signed genesis `v1` (sha256 checked) and the public Indy client ports.
- The ledger's `/register` is reached only through an SSH forward (`127.0.0.1:19000` → VM `127.0.0.1:9000`) and used only for a **throwaway spike endorser**. The real staging endorser key never left the VM.
- Code: `12id/services/spikes/` (`tsc --noEmit` clean, `erasableSyntaxOnly`).

Tiers follow 4-init §0.1: *confirmed (run)*, *confirmed (source read)*, *not yet tested*.

---

## T2 — Author/endorser flow (PASSED)

Run: `node src/t2-endorsement.ts` (store `spike_p2t21789293028224`).

```
spike endorser DID: did:indy:twelveid:staging:N3YX7unyWS1iSNXeVc4seL
tenant DID on ledger: did:indy:twelveid:staging:EAHqZgP3xBtmKuCMe57eWu role=null
cred def (unqualified): EAHqZgP3xBtmKuCMe57eWu:3:CL:35:default
cred def private records in tenant wallet: 1 (expected 1)
after reopen: tenantCount 1, DID present, cred def private key present, cred def resolves
=== T2 PASSED ===
```

### The flow that works (confirmed, run)
| Object | 1. Tenant (author) | 2. Endorser | 3. Tenant |
|---|---|---|---|
| **NYM** | `dids.create({ method: 'indy', options: { endorserDid, endorserMode: 'external' } })` → `didState.state = 'action'`, `nymRequest` **unsigned**, `identifier` = endorser nym, no `role` | `indyVdr.endorseTransaction(nymRequest, endorserDid)` → signs **as author** (`signature`) | `dids.create({ did, options: { endorserMode: 'external', endorsedTransaction: { nymRequest } } })` → `finished` |
| **SCHEMA** (type 101) | `anoncreds.registerSchema({ schema, options: { endorserMode: 'external', endorserDid } })` → `schemaRequest` signed by the tenant, `endorser` = endorser nym | `endorseTransaction` → `signatures: { <tenant>, <endorser> }` (the single `signature` field is replaced) | `registerSchema({ schema, options: { endorserMode: 'external', endorsedTransaction } })` → `finished` |
| **CLAIM_DEF** (type 102) | `registerCredentialDefinition({ credentialDefinition: { issuerId, schemaId, tag }, options: { supportRevocation: false, endorserMode: 'external', endorserDid } })` → `credentialDefinitionRequest` + the **full** `credentialDefinition` | `endorseTransaction` (multi-sign) | `registerCredentialDefinition({ credentialDefinition: <the full one from step 1>, options: { …, endorsedTransaction } })` → `finished` |

- **The tenant DID has no ledger role** (`GET_NYM` → `role: null`). Tenants cannot write NYMs for anyone else.
- **The endorser never submits anything to the ledger.** The tenant submits all three transactions. The endorser-service (A9) is a signer only.
- **The tenant DID takes its namespace from the endorser DID** (`IndyVdrIndyDidRegistrar`: `did:indy:${endorserNamespace}:…`). The endorser's namespace is therefore the platform namespace for every tenant.

### Traps found (each would fail or corrupt silently)
1. **Cred def submit must pass the full credential definition from the action state.**
   - `AnonCredsApi.registerCredentialDefinition` generates a new key pair unless the input has `value` (`isFullCredentialDefinitionInput`).
   - Resubmitting `{ issuerId, schemaId, tag }` would create a second private key that does not match the endorsed transaction.
   - Confirmed (run): passing the action-state object leaves exactly one private record.
2. **The cred def private key is saved at the *action* step, before endorsement** (`storeCredentialDefinitionPrivateAndKeyCorrectnessRecord` runs whenever a `credentialDefinitionId` is present; source read).
   - A crash between action and submit leaves a private key for a cred def that is not on the ledger.
   - Resuming must reuse the stored action-state `credentialDefinition`, so **A3/A4 must persist it** in our database.
   - A fresh retry would try to save a second private record under the same id (not run).
3. **The tenant DID record is saved at the *action* step too** (`saveDidRecord` before returning the action; source read). A DID in the wallet does not prove its NYM exists. A3's state machine must verify with `GET_NYM`, as the spike does.
4. **Credo signs whatever it is given.** `IndyVdrApi.endorseTransaction` only checks that the `endorser`/`identifier` field matches. Every policy rule is ours; the spike's `checkEndorsementPolicy` (`spikes/src/ledger.ts`) refused all four probes:

   | Probe | Refusal |
   |---|---|
   | NYM with role 101 | `NYM requests role 101; tenants must be role-less` |
   | NYM for another DID | `NYM dest … is not the tenant DID` |
   | Schema from a foreign author | `author … is not the tenant` |
   | ATTRIB (type 100) sent as a schema | `expected type 101, got 100` |
5. **Policy must inspect the request *before* endorsement.** After multi-signing, `signature` is gone and `signatures` holds both keys, so a "has author signature" check only works on the tenant-signed input.

### Postgres store (confirmed, run)
- `multiWalletDatabaseScheme: ProfilePerWallet` must be set explicitly; Credo's default is `DatabasePerWallet` (`AskarModuleConfig`, "for backwards compatibility").
- Closing and reopening the root store kept the tenant, its DID, its cred def private key and the ability to resolve the cred def.
- The benign `[error] root Error occurred during transaction, rollback {"error":{"code":3}}` appears on reopen, exactly as Phase 1 W3 saw.

### Consequences for the build
- **A9 endorser-service:** two operations (sign-as-author for NYM, multi-sign for SCHEMA/CLAIM_DEF), each behind `checkEndorsementPolicy`; no ledger writes. It still loads the pool config, because `endorseTransaction` resolves the pool for the endorser DID when signing an unsigned NYM (source read).
- **A3/A4 state machine:** persist `nymRequest` / `schemaRequest` / action-state `credentialDefinition` and the endorsed transaction at each step, so every step is resumable without regenerating keys.

---

## T1 — Two tenants on Postgres (PASSED)

Run: `MEDIATOR_INVITATION_FILE=… node src/t1-tenants.ts` (store `spike_p2t11789293153362`).

**Setup:**
- one root agent (Askar Postgres, `ProfilePerWallet`) with **one** inbound endpoint (`http://127.0.0.1:3500`);
- two tenants, each onboarded with the T2 flow;
- **one** Credo holder behind the staging mediator (`wss://mediator.12id…`, HTTP outbound, `PickUpV2`), connected to both tenants;
- both tenants running connect → issue v1 → verify v1 (with the `expiresAt >=` predicate) **concurrently**.

```
[tenant-a] connected / credential issued through the mediator / proof isVerified: true
[tenant-b] connected / credential issued through the mediator / proof isVerified: true
results: both isVerified true, connectionsInTenant 1 each
event contexts seen on the root emitter: tenant-1472c4b3…, tenant-4de20118…
credential/proof events not tagged with a tenant context: 0
v1 protocol messages: 24 / v2 protocol messages: 0
=== T1 PASSED ===
```

### Confirmed (run)
- **One endpoint, correct routing.** Inbound messages for both tenants arrived at the same URL and were processed in the right tenant context; each tenant holds exactly one connection.
- **Root DIDComm config applies inside tenants:** v1-only protocols, auto-accept and the unqualified cred def IDs all worked in tenant contexts without any per-tenant configuration.
- **Events for all tenants arrive on the root agent's emitter**, each tagged `metadata.contextCorrelationId = "tenant-<tenantId>"` (7 credential/proof transitions per tenant). A6 subscribes once, on the root, and maps the context id to the tenant.
- **Storage layout:** one Postgres database per root store, one Askar **profile** per tenant (`profiles`: `1 | spike_p2t2…` root, `2 | tenant-53127d60…`). No database per tenant.
- **Expiry predicate (`expiresAt >= now`) verifies** with an epoch-seconds string attribute (4-init §4.7, §5.2).

### Traps found
1. **The default cache breaks the second tenant.**
   - First run: tenant A onboarded, then tenant B failed at cred def registration with `SingleContextStorageLruCache can not be used with multiple agent context instances. Register a custom cache implementation in the CacheModule.`
   - The default cache binds to the first agent context that uses it. **T2 passed only because it had one tenant.**
   - Fix: `cache: new CacheModule({ cache: new InMemoryLruCache({ limit: 500 }) })` on the root agent.
2. **`InMemoryLruCache` is shared across tenants and ignores the agent context in its keys** (source read). What goes in it:

   | User | Key | Data |
   |---|---|---|
   | `DidResolverService` | DID | resolved DID document (public) |
   | `IndyVdrPoolService` | DID | `GET_NYM` response (public) |
   | `AnonCredsRegistryService` | object id | schema / cred def / rev reg (public ledger objects) |
   | `Repository.findSingleByQuery` (only if `useCachedStorageService: true`) | `ourDid…theirDid…` (connections) | **wallet record JSON** |

   **Rule: never enable `useCachedStorageService` with a shared cache.** The connection cache key carries no tenant, so one tenant's connection record could be served to another. With the default `false`, only public ledger data is shared, which is safe. The cache is also per process, so multiple replicas each warm their own.
3. **Connection event name.** `DidCommConnectionEventTypes.DidCommConnectionStateChanged` has the string value **`"ConnectionStateChanged"`**, without the `DidComm` prefix that credential (`DidCommCredentialStateChanged`), proof (`DidCommProofStateChanged`), out-of-band and mediation events carry. The spike subscribed by string and received **no connection events at all**, silently. **A6 must subscribe via the exported enum constants, never string literals.**
4. **Messages are processed one at a time across all tenants** (source read). `DidCommModule.initialize` pipes `DidCommMessageReceived` through `mergeMap(…, processDidCommMessagesConcurrently ? undefined : 1)`, and `processDidCommMessagesConcurrently` defaults to `false`. Every inbound message for every tenant queues behind the one being processed, including its ledger reads. This is the first multi-tenant throughput limit; enabling concurrency needs its own test (A1, Phase 6 load test).

### Not covered by T1
- **The native Kotlin holder against a tenant issuer.** It uses `connections/1.0`, not `didexchange/1.1` as this Credo holder did. That is T4 / A11 on device.
- Session-limit behaviour (`sessionLimit: 20` was never reached) and more than two tenants.

---

## T3a — Hard kill mid-exchange

Run: `T3_STATE_FILE=… MEDIATOR_INVITATION_FILE=… node src/t3a-kill.ts`.
- The issuer is a child process on a Postgres store (`spike_p2t31789293551778`, one tenant), driven over a local control API.
- The holder is a Credo agent behind the staging mediator with auto-accept off.

**Sequence:** offer → holder receives it → `SIGKILL` the issuer → holder accepts → restart the issuer on the same store.

### Confirmed (run)
| Check | Result |
|---|---|
| Store reopens after SIGKILL | **Yes.** No lock and no corruption; only the known benign `rollback {"error":{"code":3}}` line |
| Tenant and connection after restart | Intact; connection `completed` |
| Holder accept while the issuer is down | Throws `Message is undeliverable to connection …` (`fetch failed`) |
| Holder record after that failed accept | **`request-sent`**: the state advanced although the message was never delivered |
| Issuer record after restart | **`offer-sent`**, stuck; nothing on the issuer knows a request was attempted |
| Recovery A: holder accepts the same offer again | Refused: `Credential record is in invalid state request-sent. Valid states are: offer-received.` There is no resend API |
| Recovery B: issuer re-offers on the same connection | **Works** (confirmation run). The holder received offer 2, reached `credential-received`, accepted the credential and reached `done`; the issuer record shows `credential-issued` when read right after. No store errors. The first run reported a stall only because the harness waited for `done` without calling `acceptCredential` on a holder with auto-accept off |
| Stranded records | **Every kill leaves one issuer record at `offer-sent`, permanently.** After four kill runs on this tenant, the store held four such records beside the completed ones. Nothing ever clears them |

Reading the issuer record immediately after the holder reached `done` showed `credential-issued`, not `done`. Most likely the holder's ack had not been processed yet; not separately checked. Webhook semantics should treat `credential-issued` as "delivered" and `done` as "acknowledged".

The confirmation run still printed `=== T3a FAILED ===`. Its pass check wanted exactly one connection, but the reused state file had given the tenant five from earlier runs. The check now looks at the connection's state instead; no Credo behaviour was involved.

**Consequences (these hold whatever the open item turns out to be):**
- **A failed send desynchronises the two sides permanently.** The holder believes it is at `request-sent`, the issuer at `offer-sent`, and neither side retries. An issuer outage during the window between offer and request strands every exchange in that window.
- **A5/A8 need a reconciliation job:** issuer exchanges sitting in `offer-sent` / `request-received` / `presentation-received` past a TTL are marked abandoned (webhook to the platform) and re-offered or re-requested on a new thread. Relying on the holder to recover is not an option; the native holder behaviour on a failed send is **not yet tested** (T4).
- **Rolling deploys must drain first** (T3b), because every holder request arriving while the agent is down is lost for good.

### Correction: the recovery B "stall" was a harness bug
The first run's `timed out waiting for holder credential done` came from the test, not from Credo:
- The holder has auto-accept off. After the credential arrives it waits at `credential-received` until `acceptCredential` is called, and only then sends the ack and reaches `done`. The harness never called it.
- The shutdown-time log line `Received response message over DidCommHttpOutboundTransport while transport was not active.` was a pickup response landing while the holder was stopping, and is unrelated.

**Lesson for A5 and the smoke tests:** with auto-accept off, "credential delivered" is `credential-received` on the holder and `credential-issued` on the issuer, not `done`. Every wait in our tooling must name the state it actually expects.

`DidCommHttpOutboundTransport` details worth keeping (source read):
- the 15 s abort timer is cleared once response headers arrive;
- reading the response body then has **no timeout**;
- a response arriving after `stop()` is logged at error level.

---

## T3b — SIGTERM while a message is being processed (Linux container)

Run in `node:22.20.0-bookworm-slim` (Linux `npm ci` into a named volume; Postgres reached over the Docker network `12id-p2`), because on Windows a parent cannot deliver a catchable SIGTERM to a Node child.
- Same store and tenant as T3a.
- The issuer child prints `MARKER inbound` on the first envelope entering its receive pipeline after `/arm`; the orchestrator sends SIGTERM on that line.
- Both runs signalled with `inFlight=1`, i.e. inside the processing window.

### Run 1 results
| | Naive (`agent.shutdown()` on SIGTERM) | Drain v1 (stop inbound transports, wait for in-flight, then `agent.shutdown()`) |
|---|---|---|
| Shutdown | done in **5 ms** | in-flight reached 0 after **3,032 ms**, then `agent.shutdown()` **threw** |
| Errors | `Error processing inbound message: no elements in sequence` (the transport's wait for `DidCommMessageProcessed` completed empty when `stop$` fired), then `Failed to process message` | `Error during call to 'shutdown' method in module 'didcomm'`, cause `ERR_SERVER_NOT_RUNNING` |
| Issuer record after restart | **`offer-sent`**: the holder's request was lost | **`credential-issued`**: processed and persisted |
| Holder | accept resolved (HTTP returned), no credential | `credential-received`, but not recognised: this run still had the harness bug above |

### Confirmed (run)
- **A naive shutdown loses the message being processed.** The request is gone, the issuer stays at `offer-sent`, and the holder sees a resolved accept, so it has no reason to retry. Combined with T3a, this is the same permanent desync.
- **Waiting for in-flight messages works.** Processing completed and its result was persisted before shutdown.
- **`DidCommHttpInboundTransport.stop()` is not idempotent, and a failure there skips closing the store.**
  - Stopping the transport ourselves makes `agent.shutdown()` call `server.close()` a second time, which fails with `ERR_SERVER_NOT_RUNNING`.
  - `Agent.shutdown()` runs `shutdownModules` *before* `closeAgentContext`, so the throw also skips closing the store: the exact unclean shutdown A8 exists to avoid.

### Run 2 (corrected drain, corrected harness): PASSED
| | Naive | Drain v2 (leave transports running, wait for in-flight, `agent.shutdown()` once) |
|---|---|---|
| Signalled at | `inFlight=1` | `inFlight=1` |
| Shutdown | `Failed to process message`, done in 6 ms | `drained inFlight=0 after 338ms`, `SHUTDOWN_DONE after 343ms` |
| Store errors | the processing failure above | **none** |
| Holder | accept resolved, **no credential within 60 s** | **`credential-received`** |
| Issuer record after restart | **`offer-sent`** (request lost) | **`credential-issued`** |

The drain loses nothing and closes the store cleanly. The naive shutdown lost the message in both runs.

### The drain design for A8 (confirmed by run 2)
1. **SIGTERM → mark not-ready.** `/readyz` returns 503 so the edge stops routing new DIDComm traffic; Fastify stops accepting internal API calls.
2. **Wait for in-flight processing to reach 0**, counted via `DidCommMessageReceived` / `DidCommMessageProcessed` on the root emitter, with a deadline. A message that throws never emits `Processed`, which is why the deadline is required.
3. **Call `agent.shutdown()` exactly once.** It stops the transports and closes the store. Never stop Credo transports separately.
4. The container's stop grace period must exceed the drain deadline. The Compose default of 10 s is too short for a 15 s drain.

---

## A5–A7 traps found while building (confirmed, run)
1. **An attribute cannot be both revealed and predicated in one v1 proof request.** Credo throws `The proof request contains duplicate predicates and attributes: employeeNumber` (`assertNoDuplicateGroupsNamesInProofRequest`). Because every request carries the automatic `expiresAt >=` predicate, **`expiresAt` can never be in a disclosed attribute list.** The builder now refuses both cases with a 400 before Credo is called.
2. **Credo emits the first state event inside the API call** (`offer-sent` inside `offerCredential`, `request-sent` inside `requestProof`), before the caller can put a correlation id on the record. Setting the metadata afterwards leaves the first outbox row without it. Fix: the exchange function announces the id for `(tenant, kind, connectionId)` before the call; the outbox listener consumes it on the first event, stamps the record and persists it. Invitations anchor on the out-of-band id for the connection that follows.
3. **Several events for one record can arrive before the stamped record is persisted** (connections: `request-received → response-sent → completed` in one pass, each with a fresh unstamped record object). The listener remembers what it stamped per record id (bounded map), so all rows agree. Single-process by design; the record metadata is the durable copy.
4. **`credential-issued` means delivered; `done` arrives with the holder's ack** a moment later. Any wait or webhook rule that treats `done` as "delivered" will look flaky.

---

## Mediator bug: pickup-v1 messages are never removed from the Postgres queue (confirmed, run + source)

> **Phase 7 update (2026-09-22, review M18):** the patched take query `(connection_id = $1 OR $2 = ANY(recipient_dids)) AND state = 'pending'` now has a GIN index on `recipient_dids` and a partial `(connection_id, created_at) WHERE state = 'pending'` index. The `OR` branch had defeated the `connection_id` index. See [`17-phase-7.md`](17-phase-7.md) M18.

**Symptom (first Android run).** The proof reached `done` on the first presentation, then agent-service logged `Proof record is in invalid state done. Valid states are: request-sent` **every ~10 s for over three minutes**: the phone kept sending the same presentation. The mediator queue still held that connection's messages as `pending` after delivery; Phase 1 W7 had already seen "pending messages that never drain" and attributed it to shut-down holders.

**Cause (both ends read in the running images).**
- Credo 0.6 `DidCommMessagePickupV1Protocol` (batch-pickup, RFC 0212) calls `takeFromQueue({ connectionId, limit, deleteMessages: true })`: in RFC 0212 the batch response *is* the hand-over; there is no per-message ack.
- `packages/transport-queue-postgres` `TransportQueuePostgres.takeFromQueue`: when `deleteMessages` is true it "just fetch[es] messages without updating their state", a plain `SELECT … WHERE state = 'pending'`. Nothing is deleted or marked. The `deleteMessages: false` branch (pickup v2) does mark `sending` and later `removeMessages` deletes on `messages-received`.
- Upstream `main` has the same code (checked 2026-09-13).

**Effect.** Every PickUpV1 poll returns the whole history of that connection's queued messages. The Kotlin holder ignores duplicate offers/credentials (it has the thread already) but answers every copy of a proof request; the queue and the per-poll payload grow without bound; the platform would see a webhook per queued message only once, but the phone re-downloads everything each poll. This is the same 0.6 image Phase 0 and Phase 1 passed with, because their assertions only looked at the first delivery.

**Fix.** `infra/staging/mediator/Dockerfile.patched`: the pinned image plus one file, `patch/TransportQueuePostgres.js` (the built file from `375518d` with the `deleteMessages` branch replaced by `DELETE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING …`, race-free across the two replicas). Image `12id/mediator:375518d-p1`, both replicas rolled, healthy in 10 s, edge back after Caddy's next health check.

**Verified (second Android run).** Exactly one presentation received; 0 pending messages for the run's connection after the exchange (before: 3); offline credential still collected 3.1 s after reopen; the pre-patch phone's resends stopped the moment the patched replicas took over. 12 `pending` rows for long-dead holder connections remain; a retention policy for orphaned queue rows is a Phase 6 item.

**Consequence for §12.8.** The pinned image now carries a one-file patch, which is still far from owning a 0.7 port. It should be filed upstream. Until then every mediator upgrade must re-check `takeFromQueue`.

---

## A10 — Staging deployment notes
- **Edge checks from outside:** `GET https://agent.12id…/readyz` → 200, TLS verify 0; `POST /` with a wrong content type → 415 from Credo (so DIDComm reaches the agent); `/healthz`, `/tenants` → 404 (internal API not proxied); ports 3400/3410/3420 closed from the internet.
  > **Phase 7 update (2026-09-22, review M1):** `POST /` now carries a 512 KB body cap at the edge; Credo's own limit is 5 MB. A 700 KB body answers 413. See [`17-phase-7.md`](17-phase-7.md) M1 and 4-init trap 50 (the edge had not been loading Caddyfile edits).
- **Ports on the VM:** 3400 (DIDComm) and 3410 (internal API) are published on `127.0.0.1` only. Operator tooling reaches the internal API over `ssh -L 13410:127.0.0.1:3410`; that is how the smoke onboarded its tenant. The endorser-service (3420) is not published at all; it sits on the `12id-agent` network and joins `12id-mediator` only to reach the Phase 1 endorser store.
  > **Phase 7 update (2026-09-22, review H2 + H3):** superseded.
  > - platform-api joins both `12id-agent` and `12id-mediator` and held the same token, so it could reach the endorser.
  > - endorser-service is now only on `12id-endorser` (with agent-service and agent-postgres). Its store is on `agent-postgres` under the `endorser_service` role, and it accepts only `AGENT_ENDORSER_TOKEN`.
  > - Probes: platform-api, the console, biometric-service and the mediator all get `ENOTFOUND` for `endorser-service`.
  > - See [`17-phase-7.md`](17-phase-7.md) H2, H3.
- **The endorser-service refuses to start unless its store holds `ENDORSER_DID`**, so a wrong `ASKAR_STORE_ID` or key cannot silently create a new, unregistered endorser. Its provision step migrates only its own database and never provisions an Askar store.
- **Memory:** agent-service 1 GB limit, endorser-service 384 MB, agent-postgres 1 GB (fits the Phase 1 budget on 16 GB).
- **Restore drill (agent databases): done.** Backup `20260913T112814Z` restored into a scratch `postgres:15-alpine`: `agent_service` 1 tenant / 2 ledger objects / 10 outbox rows, `endorser_service` 1 binding / 3 audit rows, and the restored `agent_root` store **opened with the real store key** via the provision job (`store: existing`, `tenants: 1`). Scratch resources removed.
- **Onboarding crash-resume (local):** the dev tenant's status was rewound to `nym_written`, `nym_endorsed` and `did_created` in turn and `--resume` called each time: every run advanced to `ready`, the NYM submission was skipped because the ledger already had it, the DID never changed, and the re-endorsement appeared in the audit.
- **Backups:** `backup-postgres.sh` now also dumps `agent_root`, `agent_service`, `endorser_service` from the agent stack's Postgres. First attempt silently skipped them: `deploy.sh agent` needs `EXTRA_SECRETS="ledger mediator"` to interpolate the compose file, and the stack check swallowed that error. Fixed; next run produced all three (`agent-agent_root.dump.age` 118 kB), 8/8 checksums OK. Restore drill for the agent databases not yet done.
- **Monitoring:** blackbox probe `https://agent.12id…/readyz` added to `blackbox-http`, so `EndpointDown` covers the agent. Restarting Prometheus needs `EXTRA_SECRETS=mediator` (its compose file interpolates the drizzle exporter's DSN).
- **Caddy:** `caddy validate` warns the Caddyfile is not `caddy fmt`-formatted; harmless, reload succeeded.
- **Image build was fast** (npm layers shared with `ledger-tools`), so the 1 MB/s downlink was not a problem this time.

---

## Shutdown behaviour (source read, feeds T3)
- **`Agent.shutdown()` does not wait for in-flight messages.** It emits `stop$` (unsubscribing the receive pipeline), stops the transports, then closes the agent context (the store). A message already inside `receiveMessage` keeps running against a closed store, which is the Phase 0 `Invalid resource handle` symptom.
- **A failed outbound send is not queued or retried.** `DidCommMessageSender` emits `Undeliverable` and throws `MessageSendingError`. A holder whose request hits a stopped issuer loses that message.
- **On Windows, Node cannot handle SIGTERM from a parent** (`child.kill('SIGTERM')` terminates the process). The graceful-drain half of T3 therefore runs in a Linux container.
