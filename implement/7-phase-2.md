# Phase 2 — Agent services (plan)

## Context
Phase 1 is complete (`12id/implement/5-phase-1.md`, `12id/implement/6-phase-1-findings.md`, 4-init updated). Staging on `id-dev` (`*.12id.naziharitsolution.com`) runs:
- a signed genesis `v1`;
- a von-network pool (namespace `twelveid:staging`);
- a Postgres-backed endorser DID `did:indy:twelveid:staging:9WnSruRkr6b3V7XX9zPjka` (store `endorser`);
- two mediator replicas (`QueueAndLiveModeDelivery`, Postgres queue, multi-instance `none`, webhook live);
- Caddy with TLS and rate limits, SOPS secrets, nightly backups, monitoring;
- an `indy-vdr-proxy`.

`smoke:credo` and `smoke:android` pass over TLS.

Phase 2 builds the first real product service: a multi-tenant Credo 0.7 **agent-service** that customers' tenants issue and verify through. It goes to staging and is proven with the native Android holder against a **tenant** issuer.

**Outputs:**
- the plan, copied to `12id/implement/7-phase-2.md`;
- code in `12id/services/`;
- `12id/infra/staging/compose.agent.yml`;
- `12id/implement/8-phase-2-findings.md`;
- 4-init updates.

## What Phase 1 changed for this plan
| Phase 1 fact | Effect on Phase 2 |
|---|---|
| Askar on Postgres confirmed: `store.database = { type:'postgres', config:{host:'host:port'}, credentials:{account,password,adminAccount,adminPassword} }`; store id = database name | No Postgres spike needed; the tenants-on-Postgres question remains (T1) |
| Provision explicitly with `agent.modules.askar.provisionStore()` tolerating `AskarStoreDuplicateError`; concurrent provisioning races on `CREATE SCHEMA` | A single `agent-provision` init job runs before the service; one replica in v1 |
| `label` is not an `InitConfig` option in 0.7; strip-only Node hides type errors | `tsc --noEmit` is a required CI gate |
| DIDComm config form: `new DidCommModule({ transports: { inbound, outbound }, … })` | Copy from `infra/ledger/src/smoke/agent.ts`, not `phase0/` |
| Credo WS client closes a new socket after a no-response send | The issuer's WS outbound to the mediator works (smoke passed); nothing in the agent-service may request mediation over WS |
| Holder requests go **directly** to the issuer endpoint (return routing) | The agent's DIDComm endpoint is public, TLS, rate-limited, and reachable from phones |
| Namespace must match `[a-z][_a-z0-9-]*(:…)?`; staging = `twelveid:staging` | `INDY_NAMESPACE` is config; the production namespace is decided with §12.1 |
| The staging endorser was written via `/register`; smoke issuers self-endorsed as ENDORSER | Tenants must **not** get the ENDORSER role; the real author/endorser flow (D3) is Phase 2 work |
| Clocks differ across hosts (53 s skew observed) | Correlate by DIDComm thread ID plus our correlation ID, never by time windows |
| Askar logs a benign `[error] … rollback` on duplicate provisioning | Log-based alerting must ignore it |
| Deploy pattern: `deploy.sh <stack>`, `secrets/<stack>.sops.env`, 127.0.0.1-only publishing (Docker bypasses ufw), Caddy site per host, backup script, blackbox probes | A10 follows it exactly |
| Owner actions still open: back up the age key, rotate the `ubuntu` password | **Precondition for A10** (tenant wallet keys go into SOPS) |

## Decisions
- **D1 §12.4 — one codebase, one deployment** (`AGENT_ROLES=issuer,verifier`, splittable later). Reason: connections live in the tenant wallet inside one agent.
- **D2 — two services.** Agent-service is private (internal API + outbox). The Phase 3 platform API is a separate service. Only the DIDComm endpoint is public.
  > **Phase 7 update (2026-09-22, review M5):** the internal API was built with `connectionTimeout: 10_000` to keep slow clients from holding a drain open. That is a socket idle timeout, and it destroyed the socket under long ledger handlers (trap 44). It is now `connectionTimeout: 0` with `requestTimeout: 30_000`. Idle keep-alive sockets still close on shutdown. See [`17-phase-7.md`](17-phase-7.md) M5.
- **D3 — real author/endorser flow.** The tenant key is the author and the platform endorser signs. Tenant DIDs get no ledger role.
- **D4 — Fastify** for our HTTP APIs, with `fastify-type-provider-zod` and pino (also backing the Credo `Logger`). Credo's stock Express `DidCommHttpInboundTransport` serves DIDComm on its own port.
- **D5 — decided: separate internal endorser-service.** It holds the existing `endorser` Askar store and is never reachable from the internet. It checks policy and audit-logs every signature. The key stays out of the process that accepts internet DIDComm traffic (§6).
- **D6 — toolchain.**
  - Node 22.20 runs `.ts` directly as `infra/ledger` does, with `tsconfig` `erasableSyntaxOnly: true` so strip-only-unsafe syntax fails `tsc`.
  - Tests use `node --test`, not vitest: a transforming runner risks the same dual CJS/ESM mis-resolution that broke `tsx`.
  - Drizzle + pg for our tables.
  - npm workspaces under `12id/services/`.
  - Exact version pins, copied from `infra/ledger/package.json`.

## Layout
```
12id/services/
  package.json               npm workspaces, pinned versions
  credo-base/                bindings.ts (imported first), logger.ts (pino-backed Credo Logger),
                             genesis.ts (URL + sha256), ids.ts (qualified→unqualified), askar-postgres.ts
  agent-service/
    src/agent/               root agent factory with tenants module
    src/tenants/             provisioning
    src/ledger/              schema / cred def catalogue
    src/exchanges/           invitations, offers, proof requests
    src/events/              listener → outbox
    src/http/                Fastify internal API, health
    src/db/                  drizzle schema + migrations
    src/provision.ts         init job: provisionStore + migrations
    test/
  endorser-service/          Fastify internal API over the endorser store (D5)
```
Code to reuse:
- `infra/ledger/src/bindings.ts`, `logger.ts`
- `infra/ledger/src/smoke/agent.ts` (module config, genesis loader)
- `infra/ledger/src/smoke/ledger-objects.ts` (publish + ID derivation)
- `infra/ledger/src/bootstrap-endorser.ts` (Postgres store, provisioning, `GET_NYM` checks)
- `infra/ledger/src/smoke/wire-log.ts`

`infra/ledger` itself is left unchanged.

## Spikes first (each recorded in `8-phase-2-findings.md`; they gate the A-items noted)
Run from the workstation against **staging** (public genesis + client ports), with a local Docker Postgres. Writes go through an SSH forward, as `smoke-android` did.

- **T1 — tenants on 0.7.0, Postgres** (gates A1, A3–A5).
  - Setup: install `@credo-ts/tenants@0.7.0`; root agent with 2 tenants on a Postgres Askar store.
  - Record the storage scheme: profile per tenant in one store (expected) vs database per tenant.
  - Confirm that the root DIDComm config applies inside tenant agents:
    - `useDidSovPrefixWhereAllowed` and v1 protocols;
    - one inbound endpoint routing to the right tenant;
    - events carrying `contextCorrelationId` → tenant id;
    - `withTenantAgent` session behaviour under concurrent exchanges.
  - Exit: v1 issue + verify per tenant to a Credo holder through the staging mediator (`HOLDER_OUTBOUND=http`, `PickUpV2`).
- **T2 — author/endorser on 0.7.0** (gates A3, D5).
  - Verify in the installed type declarations before designing:
    - the endorser writes a role-less tenant NYM from `{did, verkey}`;
    - the tenant authors SCHEMA / CLAIM_DEF with `endorserMode: 'external'`;
    - the endorser signs (`IndyVdrApi.endorseTransaction` or its 0.7 equivalent);
    - the tenant submits.
  - Confirm von-network's auth rules accept author + endorser signatures from a role-less author.
- **T3 — restart and shutdown** (gates A8). Kill -9 mid-exchange, then restart: the store reopens and the exchange resumes. On SIGTERM, drain before `agent.shutdown()`: no `Invalid resource handle`.

## Build workstreams
1. **A0 credo-base.** Shared bindings, logger, genesis loader, ID derivation and Postgres store config; unit tests for ID derivation.
2. **A1 Agent factory.**
   - Config from env, validated with zod.
   - Root agent: Askar Postgres, IndyVdr, AnonCreds, tenants, and DidCommModule with v1-only protocols, did:sov prefix, `autoAcceptConnections` on, credential/proof auto-accept **off** (the platform decides).
   - HTTP inbound plus HTTP+WS outbound.
   - `provision.ts` runs as a separate init job.
3. **A2 Internal API (Fastify).**
   - Health: `/healthz` (process up), `/readyz` (store open, pool connected, endorser-service reachable).
   - Command routes are scoped by `tenantId`; no customer auth, because the Phase 3 platform API owns that.
   - Bound only to the private Docker network.
4. **A3 Tenant provisioning.**
   - Flow: create tenant → tenant creates a `did:indy:<ns>` key in its own wallet → endorser writes the role-less NYM → verify with `GET_NYM` → persist.
   - Idempotent state machine (`pending → nym_written → ready`), so a crash between the ledger write and the DB write resumes instead of orphaning a NYM.
5. **A4 Catalogue.**
   - Schema publish via the author/endorser flow, requiring an integer `expiresAt` attribute.
   - Cred def with `supportRevocation: false`.
   - Persist qualified + unqualified IDs, name/version, and `active|deprecated` status.
   - Versioning: a new version creates a new schema + cred def; deprecation blocks new offers but stays verifiable (§5.1).
6. **A5 Exchanges.** All async; each returns a record id.
   - OOB invitations, single-use and multi-use.
   - `offerCredential` v1: takes the catalogue id and **refuses qualified IDs at the boundary**.
   - `requestProof` v1:
     - restrictions on unqualified cred def IDs, accepting several per logical type;
     - an `expiresAt >= now` predicate injected and non-removable.
   - Accept or decline for inbound requests and presentations, which are not auto-accepted.
7. **A6 Events → outbox.**
   - Listen for connection, `DidCommCredentialStateChanged` and `DidCommProofStateChanged` events across tenants.
   - Write each transition transactionally into an `outbox` table: tenant, record id, thread id, state, correlation id.

     > **Phase 7 update (2026-09-22, review M7):** as built, each row was a fire-and-forget autocommit. Concurrent inserts could commit out of id order, and the consumer then skipped the late one. All four writers now go through `events/outbox-writer.ts` `insertOutboxRow`, which takes an advisory lock and then inserts, in one transaction. See [`17-phase-7.md`](17-phase-7.md) M7.

     > **Phase 7 update (2026-09-28, review H1):** acknowledged outbox rows are pruned after `OUTBOX_RETENTION_DAYS` (30) by `events/outbox-prune.ts`. New `POST …/credentials|proofs|connections/:id/erase` routes delete finished Credo records with their DIDComm messages, for the platform's erasure and retention. See [`17-phase-7.md`](17-phase-7.md) H1.
   - The Phase 3 platform API consumes the outbox.
8. **A7 Correlation + wire log.**
   - A correlation id is stored as record metadata at creation, and every log line carries it with `threadId` and `tenantId`.
   - Port `wire-log.ts` behind `WIRE_LOG=1`.
9. **A8 Shutdown.** On SIGTERM/SIGINT:
   - stop Fastify and the inbound transport;
   - drain in-flight message processing with a deadline;
   - close tenant sessions;
   - then run `agent.shutdown()`.
10. **A9 Endorser-service** (D5).
    - Opens the existing `endorser` store.
    - Routes:
      - `POST /nym`: role-less NYMs only, for DIDs of tenants that agent-service registered;
      - `POST /endorse`: SCHEMA/CLAIM_DEF transactions only, author DID must be a known tenant DID.
    - Every signature is audit-logged.
    - Internal network only; shared-secret header between the two services (SOPS).

    > **Phase 7 update (2026-09-22, review M3):** the policy checks who, and now also how many. A tenant gets at most `ENDORSER_DAILY_CEILING` (default 50) schema and cred-def endorsements in any 24 hours, counted from the audit table. Refusals are audited too. NYMs are never counted. See [`17-phase-7.md`](17-phase-7.md) M3.

    > **Phase 7 update (2026-09-22, review H2):** the shared secret was not private to these two services. Phase 3 reused it as platform-api's agent token, so platform-api could call `/endorse`. Now:
    > - Only agent-service holds `AGENT_ENDORSER_TOKEN`, and the endorser refuses the platform token (401).
    > - endorser-service is only on `12id-endorser`, together with agent-service and agent-postgres.
    > - Evidence: [`infra/runbooks/postgres-roles.md`](../infra/runbooks/postgres-roles.md). See [`17-phase-7.md`](17-phase-7.md) H2.
11. **A10 Staging deploy.**
    - `compose.agent.yml` services:
      - `agent-postgres` (its own instance, 1 GB, 127.0.0.1 / not published);
      - `agent-provision` init job;
      - `agent-service` (DIDComm on `127.0.0.1:3400`, internal API on network `12id-agent` only);
      - `endorser-service` (on `12id-mediator` for the endorser DB, plus `12id-agent`).
    - `secrets/agent.sops.env`: Postgres password, root store key, inter-service secret.

    > **Phase 7 update (2026-09-22, review H2 + H3):**
    > - endorser-service is on neither `12id-mediator` nor `12id-agent` any more, only on `12id-endorser`. Its store moved to `agent-postgres`.
    > - Every service connects with its own non-superuser role (`agent_service`, `endorser_service`), created by `infra/scripts/pg-roles.sh`.
    > - The inter-service secret became `PLATFORM_AGENT_TOKEN` and `AGENT_ENDORSER_TOKEN`.
    > - See [`17-phase-7.md`](17-phase-7.md) H2, H3.
    - Caddy `agent.12id.naziharitsolution.com` → 3400, `per_ip_limit`, `/` POST only for DIDComm.
    - Add the agent databases to `backup-postgres.sh` and run one restore drill.
    - Monitoring: blackbox probe on `agent.` and a container restart alert.
    - Memory limits: agent-service 1 GB, endorser-service 256 MB.
12. **A11 Interop matrix + smoke.**
    - `smoke:tenant-credo` (Credo holder via mediator) and `smoke:tenant-android`, a copy of `smoke-android.ts` that drives agent-service's internal API over an SSH tunnel.
    - Two tenants; live, offline and proof all DONE; v1 and did:sov only; no SSH reverse tunnel for the issuer.
    - `services/VERSIONS.md` pins agent 0.7.0, mediator `375518d` (Credo 0.6.0) and the Kotlin fork commit.

## Verification
- T1–T3 recorded with log excerpts before the dependent A-items start.
- `tsc --noEmit` and `node --test` green:
  - ID derivation and qualified-ID rejection;
  - expiry predicate always present;
  - tenant provisioning resume after a simulated crash at each state;
  - endorser policy refusals (a NYM with a role, a foreign author, a non-schema transaction).
- Local integration: two tenants issue + verify through the staging mediator; each transition appears once in the outbox with thread and correlation IDs.
- Staging: `compose ps` healthy; `https://agent.…` reachable, internal API and endorser-service unreachable from outside (port scan); tenant NYMs visible role-less on the ledger browser; `smoke:tenant-android` PASSED on the phone.
- Restore drill opens the restored root store and lists both tenants.
- Kill -9 and SIGTERM behaviour per T3 on staging.

## Doc updates this produces
- **4-init:**
  - §12.4 and §12.6 decided;
  - §10 Phase 2 checklist ticked and amended (endorser-service, Fastify, `node --test`, `tsc` gate);
  - §7.1 transports config form;
  - §0.1 tenants tier;
  - §4.2 tenant onboarding flow as built.
- `12id/implement/8-phase-2-findings.md`.

## Parallel track, not in this plan
- **Android SDK (§12.6, decided to start now):** separate plan `12id/9-sdk-android.md`. Integration point: A11.
- Still open elsewhere: §12.2 wallet recovery (before the SDK API freeze), Swift pass, production namespace with §12.1, Phase 1 leftovers (M6 failover, alert email, `indy-node-monitor`).
