# SSI Platform — System Architecture and Implementation Plan

**Status:** Design handover document — **revised after Phase 0 (Android pass), Phase 1 (staging infrastructure), Phase 2 (agent services on staging), Phase 3 (platform API on staging) and Phase 4 stage 4a (operator console)**
**Audience:** Implementation engineer / coding agent
**Stack decision:** Credo-TS 0.7 + DIDComm v1 + AnonCreds + Hyperledger Indy
**Evidence:** every Phase 0 claim below is backed by a run or a source read recorded in [`../../phase0/findings.md`](../../phase0/findings.md). The pre-Phase-0 version of this document is kept at [`init.pre-phase0.md`](init.pre-phase0.md).

---

## 0. How to use this document

Sections 1–6 describe *what* the system is. Sections 7–9 list *what to install*. Section 10 is the work breakdown — treat each item there as a ticket. Section 11 lists known traps. Section 12 lists decisions, marking which Phase 0 settled and which remain open.

Package names and versions in this revision were **resolved against the live npm registry and the installed packages** during Phase 0 (September 2026). They are pinned for a reason: this ecosystem renamed itself (Hyperledger Aries → OpenWallet Foundation Credo), scopes moved, and Credo 0.7 renamed most DIDComm classes. If you move off the pinned versions, re-verify. The Credo docs at `https://credo.js.org` may lag the published packages; when they disagree, the shipped type declarations win.

### 0.1 Confidence levels — read this before treating anything here as fact

Phase 0 ran the stack end to end on Android. Content now falls into these tiers, marked inline where it matters:

**Confirmed (Phase 0, run).** Observed on the rig or the device. Includes: v1 protocol negotiation, the identifier-format requirement, the did:sov message prefix on the wire, mediator deployment and configuration, the pickup/forwarding combination that works (live and offline), native-holder connect/issue/verify, runtime genesis fetch on device, Indy client-port reachability on home Wi-Fi and one cellular carrier.

**Confirmed (Phase 0, source read, not run).** Read directly from the pinned package or repository source but not exercised. Includes: mediator push-notification/webhook behaviour, Kotlin framework push support (absent), Redis multi-instance delivery behaviour.

**Confirmed (Phase 1, staging, run).** Observed on the cloud staging environment (`5-phase-1-findings.md`). Includes:
- **TLS:** Caddy-terminated `https`/`wss` for the mediator, the issuer endpoint, genesis distribution and the ledger proxy.
- **Mediator:** two replicas sharing a Postgres pickup queue (cross-replica delivery), and the webhook firing, with its exact preconditions and body (§2.3).
- **Endorser:** a DID with its key in Postgres-backed Askar, including a backup and restore of that store.
- **End to end over the internet:** a Credo issuer and a Credo holder, and a Credo issuer and **the native Kotlin holder on a phone**. Live, offline and proof, all v1.
- **Ledger proxy:** `indy-vdr-proxy` read replies that match the pool's reply format.

**Confirmed (Phase 2, staging, run).** Observed with the deployed agent-service and endorser-service (`8-phase-2-findings.md`). Includes:
- **Multi-tenancy:** two tenants in one Credo 0.7 agent on one Postgres store (profile per tenant), one inbound endpoint routing to the right tenant, events tagged per tenant on the root emitter.
- **The author/endorser flow** for tenant DIDs, schemas and credential definitions, with a role-less tenant DID and a signing-only endorser.
- **Tenant issuance and verification over the internet:** a Credo holder behind the staging mediator against `https://agent.<domain>`, v1 only, correlation ids on every state transition.
- **Crash and shutdown behaviour:** a hard kill leaves both sides permanently desynchronised (nothing retries); a drained shutdown loses nothing; a naive `agent.shutdown()` loses the message being processed.

**Confirmed (Phase 3, staging, run).** Observed with the deployed platform-api (`10-phase-3-findings.md`). Includes:
- **Customer API end to end:** API key → catalogue → wallet → per-wallet mediator invitation → connection → v1 credential → template proof, with a Credo holder, over `https://api.<domain>`.
- **Signed webhooks** for every transition, first-attempt delivery, idempotent replays.
- **The §4.8 wake path's server half:** mediator webhook → wallet lookup through the mediator connection's `out_of_band_id` → debounced `wallet.sync_requested`.
- **The native Kotlin holder on a phone through the platform API** (`smoke:platform-android`): per-wallet mediator invitation, live and offline credentials, template proof; a message queued while the app was force-stopped produced `wallet.sync_requested` 0.4 s later and was collected 7.2 s after reopen.

**Confirmed (Phase 4, run).** Observed with the console against a local platform-api and, for the platform-api half, on staging (`12-phase-4-findings.md`). Includes:
- **platform-api console scope** (`x-console-token` + actor/role/tenant): serves the existing `/v1/*` routes and the operator routes, refuses a wrong token, audits every mutation in `console_audit`; the edge answers 404 to any request carrying the header.
- **Console auth:** invite-only accounts, mandatory 2FA (TOTP or email OTP), operators TOTP-only, TanStack Start's CSRF middleware, Playwright-driven sign-in / enrollment / operator screens.
- **Tenant portal (local):** organization owners and members through invitation mail, role limits enforced per request, a member refused on another organization's URL, role change and removal effective on the next request.

**Not yet tested.** Stated from documentation or reasoning only. Includes:
- invited-member acceptance through real SMTP on staging, and a `console` database restore;
- **everything about the Swift/iOS holder**;
- the native Kotlin holder against a **tenant** issuer (it was tested against a single-tenant smoke issuer);
- multi-tenant throughput: inbound messages are processed one at a time across all tenants by default;
- mediator replica failover under load, and duplicate webhooks across replicas;
- restrictive corporate Wi-Fi;
- production (non-von-network) ledgers and the TAA;
- the customer-side push → `sync()` half of §4.8.

Phase 0 found that the architecture holds. It also found that **three configuration switches, two holder fork changes and one mediator setting** must all be right, and each fails silently when wrong (§2.7.1, §2.7.4, §2.3). Treat those as load-bearing.

### 0.2 Ledger object identifiers — resolved

The same ledger object can be addressed two ways: legacy unqualified (`Th7MpTaRZVRYnPiabds81Y:2:schema:1.0`) or fully qualified (`did:indy:...`). **Phase 0 result: issue-credential v1 and present-proof v1 require the legacy unqualified form on the wire.** This is enforced inside Credo's own v1 format service, not just by the native holder — see §2.7.2. The issuer's DID can still be `did:indy`; what must be unqualified is the schema and credential-definition identifiers inside offers and proof requests.

---

## 1. Scope and design decisions

### 1.1 What we are building

A multi-tenant self-sovereign identity platform. Our customers are organisations who want to issue and verify verifiable credentials. We provide:

- Hosted issuer and verifier agents, driven by a REST API
- A native mobile SDK (iOS and Android) our customers embed in **their own** apps to act as the credential holder
- The supporting infrastructure: DIDComm mediator and Indy ledger access

### 1.2 Locked-in decisions

| Decision | Choice | Reason |
|---|---|---|
| Credential format | AnonCreds | Selective disclosure, predicate proofs, unlinkable presentations |
| Transport protocol | DIDComm v1 | Required by AnonCreds-over-DIDComm ecosystem; what the mediator and native frameworks support |
| Issue / present protocols | **issue-credential v1, present-proof v1** | The native holders implement only RFC 0036/0037 (confirmed in source; negotiated on device) |
| Trust registry | Hyperledger Indy | Native home for AnonCreds objects |
| Identifiers on the wire | **Legacy unqualified** schema and cred-def IDs | Required by Credo's v1 format service (§2.7.2) |
| Server framework | **Credo-TS 0.7.0** (Node.js) | Still ships the v1 protocols; accepts the legacy DIDDoc context the Kotlin holder sends (§2.7.4) |
| Holder implementation | Native (Swift + Kotlin) forks | We ship an SDK for embedding in customer apps; React Native is not viable as an embedded SDK |
| Message pickup | **Holder `PickUpV1` + mediator `QueueAndLiveModeDelivery`** | The only combination that delivers both live and offline to the native holder (§2.7.3) |
| Key custody | On device | Holder keys and link secret never leave the user's phone |
| Revocation | **Not in v1** | Decided before Phase 0; see §12.3 for the consequences |

### 1.3 Explicitly out of scope for v1

- **Credential revocation** (tails server, revocation registries, non-revocation proofs) — see §12.3
- DIDComm v2 (not supported by the native holders; roadmap item only)
- Pickup v2 / live mode (not implemented by the native holders)
- OpenID4VC / SD-JWT VC (may be added later — keep the issuance API abstracted so this stays possible)
- Cloud/custodial wallets
- W3C VC Data Model credentials

---

## 2. Component inventory

### 2.1 Indy ledger pool

**Purpose.** Public, append-only registry of DIDs, credential schemas and credential definitions. **No personal data or credentials ever go here.**

**Runtime.** `indy-node` validators. Byzantine fault tolerance follows `n = 3f + 1` — four nodes tolerate one faulty node, seven tolerate two.

**Environments.**
- Dev/CI: `von-network` — Docker Compose, 4 nodes, ledger browser UI, auto-generated genesis. **On Docker Desktop for Windows it must be started with an explicit host IP** (`./manage start <LAN-IP>`); without it validators cannot reach each other and `/genesis` returns 503 indefinitely while containers look healthy. Its `/register` endpoint accepts `{did, verkey, role}`, so a dev endorser key can be generated inside the agent's KMS and never leave it.
- Production: `indy-node-container` images on dedicated hosts, or a permissioned network operated by a third party (e.g. Indicio)

**Requirements per validator.** Static public IP, two open TCP ports (node-to-node consensus, client-to-node), 8 GB RAM for private low-traffic networks.

**Roles.** Trustees govern the pool. Stewards operate validators. **Endorsers** write schemas and credential definitions — our issuer DID needs the `ENDORSER` role.

> See §12.1 — the node count decision is still open.

### 2.2 Tails server — not in v1

Revocation is out of scope for v1 (§12.3), so no tails server is deployed and no holder ever fetches a tails file. This section is kept as a pointer for when revocation is added:

- Runtime would be `bcgov/indy-tails-server` (`ghcr.io/bcgov/indy-tails-server/tails-server`), preferring its tails-hash-keyed endpoints.
- The tails URL is baked into the revocation registry definition and **cannot be changed afterwards**.
- **A credential definition published without `supportRevocation` cannot be made revocable later.** Adding revocation means new credential definitions and re-issuing existing credentials.

### 2.3 Mediator

**Purpose.** Public DIDComm endpoint that receives messages on behalf of mobile wallets, queues them, and delivers them when the wallet collects them. The wallet has no stable inbound address, so this is mandatory.

**Runtime.** `didcomm-mediator-credo`, deployed from the official Docker image. **There is no `latest` tag** — the image is published only under commit-SHA tags:

```
ghcr.io/openwallet-foundation/didcomm-mediator-credo/mediator:375518d   # tested in Phase 0
```

The tested image is built on **Credo 0.6.0** (`@credo-ts/didcomm@0.6.0`, `@openwallet-foundation/askar-nodejs@0.4.3`), not 0.7. That matters for holder compatibility — see §2.7.4 and §12.8.

**Protocols implemented.** Out-of-band invitation (RFC 0434), mediator coordination (RFC 0211), pickup v1 (RFC 0212), pickup v2 (RFC 0685), implicit pickup. Its generated invitation advertises `handshake_protocols` of both `didexchange/1.1` and `connections/1.0`, and `accept: ["didcomm/aip1", "didcomm/aip2;env=rfc19"]`. **The invitation has no `label` field** (RFC 0434 makes it optional; the stock Kotlin holder requires it — §2.7.4).

**Open mediation — confirmed gap, mitigated in Phase 3.** The mediator grants mediation to any agent that presents its invitation, and prints a reusable multi-use invitation at startup. Controlling acceptance of mediation requests is **not implemented** upstream. Built so far: per-wallet single-use invitations minted through a patched internal route (`POST /admin/invitations`, §12.8) and served only by `GET /v1/wallet/mediator-invitation` behind a wallet token; `/invite` and `/admin/*` blocked at the edge; per-IP rate limits; a mediation-spike alert. An unused invitation does not expire on the mediator. Original mitigation list:
- Do not publish a static, universally-shared invitation. Serve per-tenant or per-user invitations from the platform API behind auth, with short expiry.
- Rate limit mediation requests at the ingress layer.
- Monitor mediation record creation rate and alert on anomalies.
- Consider a reverse proxy that requires a signed token before reaching the mediator's endpoint.

**Key configuration** (Phase 0 confirmed unless marked). Config is loaded from environment variables — nested keys joined with double underscores — or a JSON file pointed at by `CONFIG`. **The Zod schema in `apps/mediator/src/config.ts` is authoritative.** `.env.example` and several validation error strings in that repo name keys that do not exist (e.g. `DRIZZLE__DIALECT`, `MESSAGE_PICKUP__FORWARDING_STRATEGRY`).

| Env var | Our setting | Notes |
|---|---|---|
| `AGENT_PORT` | `3000` (whatever the ingress targets) | **Defaults to `3110`.** `AGENT_ENDPOINTS` only sets what is *advertised*; if the two disagree every inbound connection gets an empty reply while the container looks healthy |
| `AGENT_ENDPOINTS` | `wss://…,https://…` — **WebSocket first** | Order is load-bearing: the holder does its mediator handshake over the first advertised service. With http first, the mediation grant is sent to a closed session and the holder times out. Must contain at least one `http(s)` URL or the mediator refuses to start. (Tested with `ws`/`http`; TLS variants not yet tested) |
| `MESSAGE_PICKUP__FORWARDING_STRATEGY` | `QueueAndLiveModeDelivery` | **Default is `DirectDelivery`, which loses every message sent while the wallet is closed** (§2.7.3). Must be set explicitly |
| `MESSAGE_PICKUP__STORAGE__TYPE` | `postgres` | Queue survives restarts. **Needs the Phase 2 patch (§12.8)**: unpatched, pickup-v1 hand-overs are never removed and holders are re-sent everything on every poll |
| `MESSAGE_PICKUP__STORAGE__HOST` | bare hostname, e.g. `postgres` | **No port allowed and no port key exists** (5432 assumed). `postgres:5432` fails with `ENOTFOUND` |
| `MESSAGE_PICKUP__STORAGE__{USER,PASSWORD,DATABASE}` | — | Database must exist |
| `STORAGE__TYPE` / `STORAGE__DIALECT` / `STORAGE__DATABASE_URL` | `drizzle` / `postgres` / `postgresql://…` | Run migrations first (§7.3) |
| `ASKAR__STORE_ID`, `ASKAR__STORE_KEY`, `ASKAR__DATABASE__*` | postgres | **Askar is still required for KMS when storage is Drizzle.** Unlike the pickup host, `ASKAR__DATABASE__HOST` does take `host:port` |
| `CACHE__TYPE` / `CACHE__REDIS_URL` | `redis` / `redis://…` | Required for multi-instance delivery |
| `MESSAGE_PICKUP__MULTI_INSTANCE_DELIVERY__TYPE` | **`none`** | **Confirmed (Phase 1, staging).** With the Postgres pickup queue, `redis` **silently disables every webhook** (see below). Multi-instance delivery still works with `none`: the Postgres queue itself delivers across replicas (verified with two replicas) |
| `PUSH_NOTIFICATIONS__WEBHOOK_URL` | our platform API | **Confirmed (Phase 1).** Fires only together with the Firebase placeholder below |
| `PUSH_NOTIFICATIONS__FIREBASE__NOTIFICATION_TITLE` / `__NOTIFICATION_BODY` | any non-empty text | **Required for the webhook** with the Postgres queue, even with no Firebase project. `projects` may be omitted; with no device-token record the FCM send is skipped |
| `CREATE_NEW_INVITATION` | `true` in dev | Regenerates the startup invitation instead of reusing the stored one |

**Push notifications / webhook: confirmed on staging (Phase 1, W5 M2–M4).** Source trace in `apps/mediator/src/config/pushNotificationLoader.ts`, `redisMessageDeliveryLoader.ts`, `push-notifications/sendNotification.ts` and `packages/transport-queue-postgres`; evidence in [`5-phase-1-findings.md`](5-phase-1-findings.md).

| Pickup queue | Multi-instance | Firebase block | Webhooks for 5 queued messages |
|---|---|---|---|
| postgres | `redis` | none | **0** |
| postgres | `none` | none | **0** |
| postgres | `none` | title + body only | **5** |

- **Why `redis` disables it.** The Redis delivery loader, the only multi-instance notifier, listens for `DidCommMessageQueued`, which the Postgres queue never emits; the loader's own header says the Postgres queue is not supported. The Postgres queue emits `TransportQueuePostgresMessageQueued`, and its only listener (`pushNotificationLoader`) returns unless a Firebase block exists **and** multi-instance delivery is `none`. Nothing logs this.
- **Body.** The webhook POSTs **`{ "connectionId": "..." }`** with no signature or authentication. There is **no `fcmToken` key at all**: it is `undefined` and dropped by `JSON.stringify`, not `null`. `connectionId` is the mediator-side connection id for the holder, which is the key for the platform's device-token registry (§4.8). The Kotlin holder has no push-notification protocol, so a token will never be present.
- **Frequency.** Exactly **one webhook per queued message**, including while the holder is actively polling (app open). With `PickUpV1` holders every message is queued. The platform API must de-duplicate per `connectionId`.
- **Not tested:** duplicate webhooks across replicas for one message. Not expected, since only the replica that queued the message emits the event.

**Recommended Node flags** (from the project README, not tested): `NODE_OPTIONS=--max-old-space-size=512`, `MALLOC_CONF=background_thread:true,metadata_thp:auto`, and `LD_PRELOAD` set to jemalloc.

**Critical property.** The mediator sees only encrypted envelopes. It cannot read credentials, proofs, or connection contents. It *does* see metadata: which wallet, how often, message sizes — and with `PickUpV1`, a poll from every open wallet every 10 seconds.

### 2.4 Issuer agent

**Purpose.** Holds the organisation's DID and signing keys. Publishes schemas and credential definitions. Runs the issue-credential protocol with holders.

**Runtime.** Node.js service embedding a Credo 0.7 agent, with an HTTP inbound transport on a public URL. **The endpoint must be reachable from end-user phones**, not only from the mediator: the holder posts connection requests and protocol replies straight to the agent's advertised endpoint (observed on device).

**Storage.** Askar wallet backed by Postgres. (Phase 0 used Askar/SQLite; Postgres is not yet tested.)

**Multi-tenancy.** One agent process, one tenant per customer organisation, via `@credo-ts/tenants`. Each tenant gets its own encrypted storage partition. Do **not** run one process per customer. (**Not yet tested.**)

**Mandatory configuration** — see §2.7.1 for the full set. In short: register v1 protocols explicitly, set `useDidSovPrefixWhereAllowed: true`, offer unqualified identifiers, and enable connection auto-accept or handle `request-received` explicitly.

### 2.5 Verifier agent

**Purpose.** Builds proof requests, runs present-proof v1 with holders, verifies the resulting proofs against ledger state.

**Runtime.** Same shape as the issuer. It can be the *same process* with different modules enabled, but separate deployments are recommended so verification traffic cannot starve issuance (§12.4).

**Note.** Verification is fully offline with respect to the issuer — the verifier never contacts the issuing organisation, only the ledger. Proof-request restrictions must use the **unqualified** `cred_def_id` (confirmed).

### 2.6 Platform API

**Purpose.** The product. Everything our customers actually touch.

Responsibilities:
- REST API over the issuer and verifier agents
- Tenant and API key management
- Schema and credential definition catalogue — **storing both qualified and unqualified identifiers** per ledger object (§2.7.2)
- Proof request templates
- Webhook delivery to customer backends
- **Wallets** (per-installation tokens), per-wallet mediator invitations, and the mediator webhook receiver that relays wake-ups to the customer (§4.8, §12.12). No device tokens are stored
- Admin UI
- Business-data-to-credential-attribute mapping

**Runtime.** Node.js/TypeScript. Own Postgres database, separate from the agent wallet storage.

### 2.7 Holder SDK

**Purpose.** Embedded in our customers' native apps. Holds the user's wallet, keys, link secret, and credentials on device.

**Runtime.**
- iOS: fork of `aries-framework-swift`, distributed via Swift Package Manager (**not yet tested**)
- Android: fork of `aries-framework-kotlin`, republished to our own Maven repository (Phase 0 confirmed on Android 14, arm64-v8a)

Both depend on `aries-uniffi-wrappers`, which provides Askar, AnonCreds, and Indy VDR as native bindings generated by UniFFI.

**Supported protocols — Kotlin, confirmed in source** (Swift parity not yet verified):
- RFC 0160 Connection Protocol — **the Kotlin holder's first choice**; it lists `[Connections, DidExchange11]` and used `connections/1.0` with both mediator and issuer on device
- RFC 0023 DID Exchange
- RFC 0434 Out of Band — parses `?oob=` URLs (after the fork change in §2.7.4)
- RFC 0211 Mediator Coordination
- RFC 0212 Pickup v1 (`MediatorPickupStrategy.PickUpV1`) and implicit pickup (`MediatorPickupStrategy.Implicit`). **No pickup v2 (RFC 0685) and no live mode** — zero references in the framework
- RFC 0036 Issue Credential **(v1)**
- RFC 0037 Present Proof **(v1)**
- RFC 0095 Basic Message
- HTTP and WebSocket transport. The WebSocket transport keeps **one persistent socket** regardless of pickup strategy
- **Not implemented:** RFC 0035 Report Problem, RFC 0056 Service Decorator, any push-notification protocol (no device-token registration)

**Relevant `AgentConfig` fields (Kotlin):** `genesisPath` (a plain filesystem path — runtime fetch needs no framework change), `mediatorConnectionsInvite`, `mediatorPickupStrategy` (framework default `PickUpV1`; **the sample app overrides it to `Implicit` — do not copy that**), `mediatorPollingInterval` (seconds, default 10), `useLegacyDidSovPrefix` (default `true`), `autoAcceptCredential`, `autoAcceptProof`.

**This list defines the protocol ceiling for the entire platform.** Configure the issuer, verifier and mediator to stay inside it.

### 2.7.1 Critical: three issuer/verifier settings that fail silently

Every one of these was hit in Phase 0, and each produces a stall with **no error on the sender's record**:

| Setting | Required value | Where | Failure if wrong |
|---|---|---|---|
| Credential / proof protocols | v1 registered explicitly | `DidCommCredentialV1Protocol`, `DidCommProofV1Protocol` in `DidCommModule` config | Credo defaults to v2 only (verbatim in source: *"When not provided, the `DidCommCredentialV2Protocol` is registered by default"*). The v1-only holder has nothing to negotiate |
| AnonCreds identifiers in offers / proof requests | legacy unqualified | payloads of `offerCredential` / `requestProof` | Holder answers `problem-report` `issuance-abandoned`; issuer record parks at `offer-sent` (§2.7.2) |
| Message type prefix | `useDidSovPrefixWhereAllowed: true` | `DidCommModule` config (**default `false`**) | The Kotlin holder registers its handlers under `did:sov:BzCbsNYhMrjHiqZDTUASHg;spec/…`; a `https://didcomm.org/…` message deserializes but finds no handler |

Class names changed in Credo 0.7. The pre-0.7 names in older docs (`V1CredentialProtocol`, `V1ProofProtocol`, `CredentialsModule`, `ProofsModule`) do not exist:

| Pre-0.7 | Credo 0.7.0 |
|---|---|
| `V1CredentialProtocol` | `DidCommCredentialV1Protocol` (from `@credo-ts/anoncreds`) |
| `V1ProofProtocol` | `DidCommProofV1Protocol` (from `@credo-ts/anoncreds`) |
| `CredentialsModule` / `ProofsModule` | nested `credentials` / `proofs` options on `DidCommModule` (APIs at `agent.modules.didcomm.credentials` / `.proofs`) |
| `HttpOutboundTransport` / `WsOutboundTransport` | `DidCommHttpOutboundTransport` / `DidCommWsOutboundTransport` (`@credo-ts/didcomm`) |
| `HttpInboundTransport` | `DidCommHttpInboundTransport` (`@credo-ts/node`) |
| `CredentialStateChanged` event, `payload.credentialRecord` | `DidCommCredentialStateChanged`, `payload.credentialExchangeRecord` |
| `ProofStateChanged` event | `DidCommProofStateChanged`, `payload.proofRecord` |

The v1 protocols use the `LegacyIndyDidCommCredentialFormatService` / `LegacyIndyDidCommProofFormatService` (format key `indy`). Every v1 credential and proof message sets `allowDidSovPrefix = true`, so the prefix setting above covers exactly the messages that need it; the rewrite happens at pack time in `DidCommEnvelopeService` (confirmed on the wire: the mediator logged our forwards as `did:sov:…;spec/routing/1.0/forward`).

Registering v2 **alongside** v1 remains possible and keeps the door open for a future Credo-based holder. Phase 0 ran v1-only.

### 2.7.2 Identifier format — resolved: legacy unqualified on the wire

**Confirmed.** `LegacyIndyDidCommCredentialFormatService.processOffer` (`@credo-ts/anoncreds`) rejects any offer whose `schema_id` or `cred_def_id` is not legacy unqualified, before the native holder is even involved.

**The awkward part:** `IndyVdrAnonCredsRegistry.registerSchema` / `registerCredentialDefinition` **return the qualified form** while writing the object to the ledger unqualified. The ID the registration API hands back is the one v1 refuses. Derive the unqualified form and persist both:

```ts
import {
  getUnqualifiedCredentialDefinitionId, getUnqualifiedSchemaId,
  parseIndyCredentialDefinitionId, parseIndySchemaId,
} from '@credo-ts/anoncreds'

const s = parseIndySchemaId(qualifiedSchemaId)
const unqualifiedSchemaId = getUnqualifiedSchemaId(s.namespaceIdentifier, s.schemaName, s.schemaVersion)
const c = parseIndyCredentialDefinitionId(qualifiedCredDefId)
const unqualifiedCredDefId = getUnqualifiedCredentialDefinitionId(c.namespaceIdentifier, c.schemaSeqNo, c.tag)
// did:indy:von:JLNR…/anoncreds/v0/CLAIM_DEF/61/default  ->  JLNR…:3:CL:61:default
```

The issuer DID itself was `did:indy:<namespace>:<nym>` throughout Phase 0 and caused no problem. Only the identifiers carried in protocol payloads must be unqualified. §12.5 records the decision.

### 2.7.3 Message pickup — resolved

**Confirmed on device.** Holder options are limited to `Implicit` and `PickUpV1` (§2.7). Tested against the mediator's forwarding strategies:

| Holder | Mediator `FORWARDING_STRATEGY` | Live delivery | Offline delivery | Verdict |
|---|---|---|---|---|
| `Implicit` | `QueueAndLiveModeDelivery` | **never delivers** — message queued for a "live mode" session that implicit pickup never creates | — | broken, silently |
| `Implicit` | `DirectDelivery` | works | **message lost**, no record created | unusable for §4.8 |
| **`PickUpV1`** | **`QueueAndLiveModeDelivery`** | **works** | **works** — delivered 1.7 s after the app reopened | **use this** |

With `QueueAndLiveModeDelivery` the mediator checks for a *live-mode* session (a pickup v2 concept), finds none, and queues. An implicit-pickup holder pings every 10 seconds but never drains the queue. `PickUpV1` explicitly asks for queued messages (RFC 0212 batch pickup) on every poll, so both live and offline messages flow.

**Consequences:**
- Pin `PickUpV1` in the SDK. The sample app's `Implicit` default must not ship.
- Live delivery latency is bounded by `mediatorPollingInterval` (default 10 s) — observed immediate in practice while the socket was open, but do not promise sub-second delivery.
- Every open wallet polls the mediator on that interval. That is the load profile to test (§10 Phase 6).
- The pre-Phase-0 guidance ("implicit → `DirectDelivery` **or** `QueueAndLiveModeDelivery`") was wrong in both directions.

### 2.7.4 Required holder fork changes

**Confirmed on device.** The stock Kotlin framework **cannot connect to the stock mediator at all**. Two one-line changes are needed in the fork; both are applied in `phase0/android/`:

1. **`OutOfBandInvitation.label` must be optional.** It is declared as a required constructor parameter. RFC 0434 makes `label` optional and the mediator's invitation omits it, so parsing fails with `MissingFieldException: Field 'label' is required` and mediation never starts. Change: `var label: String = ""`.
   File: `ariesframework/src/main/java/org/hyperledger/ariesframework/oob/messages/OutOfBandInvitation.kt`

2. **`DidDoc.@context` must be `https://www.w3.org/ns/did/v1` — but only while the mediator runs Credo 0.6.** The framework sends `https://w3id.org/did/v1` in its `connections/1.0` DIDDoc. Credo **0.6** validates it with `Equals("https://www.w3.org/ns/did/v1")` and rejects the request; Credo **0.7** uses `IsIn([DID_V1_CONTEXT_URL, "https://w3id.org/did/v1"])` and accepts both. Our 0.7 issuer accepted the unmodified form; the 0.6 mediator image did not. If the mediator moves to 0.7 (§12.8) this change becomes unnecessary but stays harmless.
   File: `ariesframework/src/main/java/org/hyperledger/ariesframework/connection/models/didauth/DidDoc.kt`

**Swift (not yet tested):** check both of the same points, plus pickup strategy support and `did:sov` prefix handling, before assuming parity.

---

## 3. Communication matrix

| From | To | Protocol | Transport | Direction | Notes |
|---|---|---|---|---|---|
| Holder SDK | Mediator | DIDComm v1: RFC 0211 coordination, **RFC 0212 batch pickup** | WSS, one persistent socket | Outbound from device | Poll every `mediatorPollingInterval` (10 s) while the app runs |
| Mediator | Holder SDK | DIDComm v1: batch response + queued messages | WSS | Over the holder's socket | Only in response to pickup; the holder has no inbound endpoint |
| Holder SDK | Issuer/Verifier agent | DIDComm v1 (connections/1.0 request, credential request, presentation, acks) | HTTPS | **Outbound from device, direct** | Agent endpoints must be reachable from mobile networks |
| Issuer/Verifier agent | Mediator | DIDComm v1 `routing/1.0/forward` | Holder's advertised mediator endpoint (WSS when ws is listed first) | Outbound | Credo opens a socket, sends, and closes it immediately when no response is expected — normal |
| Mediator | Platform API | HTTP webhook `{connectionId}` to a secret path | HTTP (Docker network) | Outbound | **Confirmed.** Fires per queued message; no authentication beyond the path |
| Holder SDK | Platform API | REST: `/v1/ledger`, `/v1/wallet/mediator-invitation` (wallet token) | HTTPS | Outbound from device | Phase 3 |
| Platform API | Mediator | `POST /admin/invitations` (patched route, token) | HTTP (Docker network) | Outbound | Phase 3; never reachable from the internet |
| Platform API | Customer backend | `wallet.sync_requested` webhook | HTTPS | Outbound | The customer pushes its own app (FCM/APNs); §12.12 |
| Issuer agent | Indy pool | Indy client protocol | TCP (client port) | Outbound | Writes: NYM, SCHEMA, CLAIM_DEF |
| Verifier agent | Indy pool | Indy client protocol | TCP | Outbound | Reads only |
| Holder SDK | Indy pool | Indy client protocol | TCP (non-standard ports, e.g. 9702–9708) | Outbound from device | Reads schema and cred def. See §4.6 for reachability results |
| Holder SDK | Platform API | HTTPS GET genesis | HTTPS | Outbound from device | Fetched and cached to a file at runtime (confirmed) |
| Customer backend | Platform API | REST | HTTPS | Inbound | API key auth |
| Browser (operator / tenant staff) | Console | HTTPS, Better Auth session cookie (host-only) | HTTPS | Inbound | Phase 4; `12id.<domain>` |
| Console (server functions) | Platform API | REST with the console scope headers | HTTP (Docker network) | Outbound | Phase 4; never reachable from the internet, audited per call |
| Platform API | Customer backend | HTTPS webhook | HTTPS | Outbound | Signed payloads, with retry |

**Network exposure summary.**

Publicly reachable, including from phones on cellular: mediator (WSS + HTTPS), issuer agent endpoint, verifier agent endpoint, platform API, Indy validator client ports.

Private: Postgres instances, Redis, admin UI (behind auth + IP allowlist). The mediator's webhook target on the platform API should be network-restricted or otherwise authenticated — the mediator sends no credentials.

---

## 4. Key flows

### 4.1 Ledger bootstrap (one time, per environment)

1. Stand up the Indy pool. Capture the genesis file.
2. Create a Trustee DID (network operator).
3. Create the platform's Endorser DID; Trustee writes the NYM with `ENDORSER` role. Generate the key inside the agent's KMS and register by `did` + `verkey`, so the private key never leaves the store.
4. Accept the Transaction Author Agreement if the network has one.
5. Publish the genesis file to a versioned HTTPS URL the agents and SDK fetch.

### 4.2 Tenant onboarding (per customer organisation)

1. Platform API creates a Credo tenant. (**Tenants not yet tested.**)
2. Tenant agent creates a `did:indy` DID; the platform Endorser writes the NYM.
3. Customer defines a schema through the admin UI.
4. Issuer publishes SCHEMA, then CLAIM_DEF **with `supportRevocation: false`** (v1 has no revocation; this cannot be changed later).
5. Derive the **unqualified** schema and credential-definition identifiers from the qualified ones the registry returns (§2.7.2).
6. Persist **both** identifier forms in the platform database. The unqualified form is what goes into offers and proof-request restrictions.

### 4.3 Wallet onboarding (per end user, first app launch)

1. SDK generates a wallet key, stores it in Keychain (iOS) / Keystore (Android).
2. SDK fetches the genesis file from the platform API, writes it to app storage, and passes the path as `genesisPath`. (**Confirmed on device**; no framework change needed.)
3. SDK fetches its single-use mediator out-of-band invitation from `GET /v1/wallet/mediator-invitation`, authenticated by the wallet token the customer backend created with `POST /v1/wallets` (§12.13).
4. SDK completes the DIDComm connection to the mediator (`connections/1.0` on Kotlin).
5. SDK sends a mediation request; mediator grants and returns routing key + endpoint.
6. SDK starts `PickUpV1` polling over its persistent WebSocket.
7. Nothing push-related is registered with the platform: the mediator connection created from the per-wallet invitation already identifies the wallet (§4.8).

From this point, every pairwise DID the wallet creates advertises the mediator's endpoint and routing key (observed: `serviceEndpoint: ws://<mediator>`, one routing key).

### 4.4 Connection establishment (holder ↔ issuer)

1. Customer backend calls `POST /connections/invitation`; platform returns an OOB invitation URL and QR payload.
2. Holder scans/opens it; SDK runs the connection handshake. The Kotlin holder uses `connections/1.0` when offered; the issuer must accept it.
3. Both sides end up with pairwise peer DIDs.
4. Platform API receives a Credo connection event, persists it, fires a webhook to the customer.

Connections are pairwise — the same user talking to two customers has two unrelated DIDs and cannot be correlated across them.

Issuer and verifier agents must either enable `connections.autoAcceptConnections` or handle the `request-received` state explicitly; otherwise the responder parks there with no error.

### 4.5 Credential issuance

1. Customer backend calls `POST /credentials/offer` with a connection ID, credential definition (by catalogue ID) and attribute values.
2. Platform maps the payload, calls `agent.modules.didcomm.credentials.offerCredential({ protocolVersion: 'v1', credentialFormats: { indy: { credentialDefinitionId: <unqualified>, attributes } } })`, and returns a record ID **immediately**.
3. Offer travels: issuer → mediator (forward) → queued → collected by the holder's next `PickUpV1` poll.
4. SDK surfaces the offer; user accepts.
5. SDK sends a credential request (containing a blinded commitment to the link secret) **directly to the issuer's endpoint**.
6. Issuer signs and issues; the credential travels via the mediator; holder stores and acks.
7. Credo emits `DidCommCredentialStateChanged` at every step. The platform listener persists state and fires webhooks.

**Nothing about this transaction is written to the ledger.**

### 4.6 Presentation / verification

1. Customer backend calls `POST /proofs/request` with a template ID and connection ID.
2. Platform expands the template into a present-proof **v1** request: requested attributes, predicates, and restrictions on the **unqualified** `cred_def_id` (and/or `issuer_did`). No non-revocation interval in v1.
3. Request travels to the holder via the mediator.
4. SDK finds matching credentials, presents the choice to the user.
5. SDK builds a zero-knowledge proof, reading schema and credential definition from the ledger, and sends it directly to the verifier.
6. Verifier resolves schema and credential definition from the ledger, and verifies.
7. Platform fires a webhook with the verification result and disclosed attributes.

> **Reachability (Phase 0 results).** Step 5 requires the *holder's phone* to reach Indy validators' client ports directly. Against the public BCovrin Test network (ports 9702–9708), a TCP connect **succeeded from the phone on home Wi-Fi and on cellular (Grameenphone LTE)**, with identical results from a wired host. (A second BCovrin host refused its Indy ports from every network, i.e. a server-side outage.) Limits: TCP connect only, not a full ledger read over cellular; one carrier; **restrictive corporate Wi-Fi not yet tested**. Keep `indy-vdr-proxy` (ledger reads over HTTPS on 443) as a Phase 1 fallback until a corporate network has been tried. Note that using it would require the native frameworks to support an HTTP resolver instead of a direct pool connection — verify feasibility before relying on it.

### 4.7 Revocation — not in v1

Out of scope (§12.3). An issued AnonCreds credential **stays cryptographically valid indefinitely**; AnonCreds has no built-in expiry. "Short-lived credentials" therefore has to be implemented in the data model:

- Include an integer expiry attribute (e.g. epoch seconds as a string, per §5.2) in every schema.
- Verifier proof templates add a predicate on it (`expiresAt >= now`) and must never omit it.
- Re-issue on expiry.

If revocation is added later, the original flow applies (registry entries batched, rollover when full), and every existing credential definition must be replaced (§2.2).

### 4.8 Offline / background message delivery

**Revised in Phase 3 (§12.12).** The mediator cannot learn device tokens from our holder, and any token belongs to the customer's own Firebase/Apple project, so the platform relays the wake-up to the customer instead of pushing.

1. The wallet's mediator connection was created from an invitation minted for that wallet (§4.3 step 3); the mediator stores its `out_of_band_id`.
2. A message for the holder arrives at the mediator and is queued (`QueueAndLiveModeDelivery`).
3. Mediator POSTs `{ connectionId }` to `platform-api/internal/mediator/<secret>` (**confirmed**; needs multi-instance `none` + the Firebase placeholder, §2.3). One call **per queued message**, including while the app is open.
4. Platform API reads the connection's `out_of_band_id` (read-only role on the mediator database), finds the wallet, and emits at most one signed `wallet.sync_requested` webhook per wallet per 30 s (**confirmed**).
5. The customer backend pushes its app with its own FCM/APNs; the app calls the SDK's `sync()`.
6. SDK runs a `PickUpV1` batch pickup immediately; queued messages are delivered. (**Confirmed:** after a force-stop, a credential offered while the app was closed was collected 1.7 s after the app reopened.)

> Design note: the SDK should expose `sync()` for the host app to call from its own notification handler, rather than claiming a notification category. Customers will already have push infrastructure. `sync()` should trigger a pickup immediately rather than waiting for the next poll.

---

## 5. Data and storage

| Store | Contents | Encryption |
|---|---|---|
| Agent Askar wallet (Postgres) | DIDs, keys, connections, credential records, protocol state | Askar encrypts at rest with the store key |
| Platform database (Postgres) | Tenants, API keys, schema catalogue with **qualified + unqualified identifiers**, proof templates, webhook config, **device push tokens keyed by mediator connection**, denormalised protocol state for querying | Standard DB encryption |
| Mediator database (Postgres) | Connections, mediation records (Drizzle); queued encrypted messages (pickup queue database); Askar KMS store | Askar / Drizzle |
| Redis | Mediator cache, multi-instance delivery streams, platform job queue | — |
| Device (Askar/SQLite) | User's keys, link secret, credentials, connections, cached genesis file | Askar, key in Keychain/Keystore |
| Indy ledger | DIDs, schemas, cred defs | Public, unencrypted, immutable |

**Never store on the ledger:** personal data, credential attribute values, connection records, presentation records, hashes of personal data.

### 5.1 Schema and credential definition immutability

Ledger objects cannot be modified or deleted. Consequences to design for:

- A schema's attribute list is fixed at publication. Adding a field means publishing a **new schema version** and a new credential definition. Build version handling into the catalogue from the start — customers *will* ask to add a field.
- Credentials already issued against the old credential definition remain valid. Proof request templates must be able to accept multiple credential definition IDs for the same logical credential type.
- Plan a deprecation flow: mark a schema version inactive for new issuance while keeping it accepted for verification.
- Include the expiry attribute (§4.7) in the first version of every schema; it cannot be added later without a new version.

### 5.2 Attribute encoding

AnonCreds attribute values are strings, with an integer encoding derived for the cryptographic layer. Credo handles the encoding, but the constraint is real: no nested objects, no arrays, no native numeric or date types. Dates go in as ISO strings or epoch integers-as-strings. Predicates (`>=`, `<`) only work on attributes whose values are integers — which is why the expiry attribute must be an integer.

Document this clearly for customers — it is the most common source of schema design mistakes.

### 5.3 Data protection posture

Because no personal data touches the ledger, the usual "blockchain vs right to erasure" conflict does not apply. The answer to a deletion request is: delete the holder's wallet data (on device, under the user's control) and delete our platform records.

**v1 caveat:** without revocation an issued credential cannot be invalidated. It remains usable until its expiry attribute passes. Customer-facing documentation must say so, and customers with a need to invalidate credentials early are a reason to revisit §12.3.

Write this up once as a customer-facing document — every enterprise customer's legal team will ask.

---

## 6. Security notes

- **Store keys** for Askar wallets go in a secrets manager, never in environment variables committed anywhere.
- **The console token (`CONSOLE_TOKEN`) can act as any tenant and as an operator** (Phase 4). It exists only in the console's and platform-api's environment on the private network, the edge refuses the header, and every use is audited with the acting user. Treat it like the endorser store key.
- **Endorser DID private key** is the highest-value secret in the system. Anyone with it can publish credential definitions under our name. Consider an HSM or at minimum a separate, tightly-scoped secrets store.
- **Wallet recovery** is not solved by default. If a user loses their phone, their link secret and credentials are gone. Decide explicitly: accept re-issuance as the recovery path, or build an encrypted backup/export flow. This is a product decision, not a technical one.
- **Open mediation is confirmed** (§2.3) — access control is ours to build before production.
- **The mediator webhook is unauthenticated** (source read). Network-restrict the receiving endpoint or front it with a proxy that adds authentication; never treat its payload as trusted input.
- **Mediator metadata** leaks traffic patterns per connection, including a poll every 10 seconds from each open wallet. Document this for customers.
- **Genesis file integrity** matters — a malicious genesis file points a wallet at a fake ledger. Serve it over HTTPS with pinning, or sign it.
- **No revocation in v1** means a leaked or wrongly issued credential cannot be invalidated before its expiry attribute passes (§4.7).

---

## 7. Packages — server side (Node.js)

### 7.1 Issuer and verifier agents

**Pinned and verified matrix (Credo 0.7.0).** Pin exactly; do not use caret ranges.

```
@credo-ts/core                        0.7.0
@credo-ts/node                        0.7.0
@credo-ts/askar                       0.7.0
@credo-ts/anoncreds                   0.7.0
@credo-ts/indy-vdr                    0.7.0
@credo-ts/didcomm                     0.7.0   # DIDComm moved out of core in 0.6+; nothing works without it
@credo-ts/tenants                     0.7.0   # not yet tested
@openwallet-foundation/askar-nodejs   0.6.0   # Askar moved to the OWF scope
@hyperledger/anoncreds-nodejs         0.4.0   # still @hyperledger
@hyperledger/indy-vdr-nodejs          0.3.0   # still @hyperledger
```

Only Askar moved to the OpenWallet Foundation scope; the AnonCreds and Indy VDR bindings are still under `@hyperledger`. The `@credo-ts/*` 0.7.0 packages are ESM.

**Runtime rules learned in Phase 0:**

- **Import the native binding packages before any `@credo-ts/*` package.** `askar-shared` exports `askar` as `undefined` until `askar-nodejs` registers it, and Credo's bundled build captures the binding at module-init time. Wrong order fails at agent init with `Cannot read properties of undefined (reading 'keyGetJwkSecret')`, which looks like a version mismatch but is not. Put the three binding imports in one module and import it first.
- **Do not use `tsx`.** It mis-resolves `webcrypto-core`'s dual CJS/ESM export (`Class extends value undefined`). Plain `node` works, as does a `tsc` build. If you rely on Node's strip-only TypeScript mode, avoid constructor parameter properties (unsupported there).
- **Credo's bundled `ConsoleLogger` produced no output** at any level on this build. Supply your own `Logger` implementation from day one; the default being silent is what makes stalls across the mediator so hard to diagnose (§11.16).
- `oob.receiveInvitationFromUrl(url, config)` — passing `{}` overrides the agent label with `undefined` and the handshake then fails class validation. Pass `{ label }` explicitly.

**Minimal agent configuration** (the shape that passed Phase 0; storage and endpoints simplified):

```ts
import 'reflect-metadata'
import { anoncreds, askar, indyVdr } from './bindings'  // must come first — see above

const agent = new Agent({
  config: { label, logger: new MyLogger() },
  dependencies: agentDependencies,
  modules: {
    askar: new AskarModule({ askar, store: { id, key } }),
    indyVdr: new IndyVdrModule({ indyVdr, networks: [{ isProduction, indyNamespace, genesisTransactions, connectOnStartup: true }] }),
    anoncreds: new AnonCredsModule({ anoncreds, registries: [new IndyVdrAnonCredsRegistry()] }),
    dids: new DidsModule({
      registrars: [new IndyVdrIndyDidRegistrar()],
      resolvers: [new IndyVdrIndyDidResolver(), new IndyVdrSovDidResolver()],
    }),
    didcomm: new DidCommModule({
      endpoints: [publicEndpoint],
      useDidSovPrefixWhereAllowed: true,                       // §2.7.1
      connections: { autoAcceptConnections: true },            // or handle request-received
      credentials: { credentialProtocols: [new DidCommCredentialV1Protocol({ indyCredentialFormat: new LegacyIndyDidCommCredentialFormatService() })] },
      proofs: { proofProtocols: [new DidCommProofV1Protocol({ indyProofFormat: new LegacyIndyDidCommProofFormatService() })] },
    }),
  },
})
agent.modules.didcomm.registerOutboundTransport(new DidCommHttpOutboundTransport())
agent.modules.didcomm.registerOutboundTransport(new DidCommWsOutboundTransport())   // needed: holders advertise the mediator's ws endpoint
agent.modules.didcomm.registerInboundTransport(new DidCommHttpInboundTransport({ port, app }))  // `app` lets extra routes share the port
await agent.initialize()
```

Supporting libraries (our choices, not prescribed by Credo):

```
express            # or fastify / nestjs — HTTP server (DidCommHttpInboundTransport accepts an existing express app)
tsoa               # optional: generates OpenAPI from controllers (credo-controller uses this)
zod                # request validation
drizzle-orm | prisma   # platform database
pg                 # postgres driver
bullmq + ioredis   # job queue for webhook retries and push de-duplication
pino               # structured logging (also back the Credo Logger with it)
@opentelemetry/*   # tracing
```

### 7.2 Reference implementations to read before writing code

| Project | Why |
|---|---|
| `openwallet-foundation/credo-ts` → `/demo` | The DIDComm + AnonCreds demo. Check which Credo line it targets before copying API calls — 0.7 renamed most DIDComm classes. |
| `@credo-ts/rest` (in `openwallet-foundation/credo-ts-ext`) | Official REST wrapper. **Appears stale** — the Credo docs for it reference a much older core version. Read it for design reference; verify carefully before adopting as a dependency. |
| `credebl/credo-controller` | More actively maintained REST controller fork. Good reference for API design even if not adopted. |
| `phase0/agent/src/` in this repo | The Phase 0 rig: working 0.7 agent factory, ledger bootstrap with identifier derivation, wire-level message logger, and end-to-end scripts. Throwaway code, but every API call in it is known to work. |

**Read at least one of these end to end before designing our API.** They encode several weeks of design decisions.

### 7.3 Mediator

No code to write if the published image is used — deploy it and configure it (§2.3). Dependencies: Postgres, Redis.

Repository: `openwallet-foundation/didcomm-mediator-credo`. Image tags are commit SHAs only; pin one.

Postgres needs three databases: the Drizzle storage database, the pickup-queue database, and one named after `ASKAR__STORE_ID` (the repo's `development/init.sql` creates them).

Run Drizzle migrations as a separate container from the same image before starting the mediator. **The command previously documented here does not work:** the repository root and `apps/mediator` both have the package name `didcomm-mediator-service`, so `pnpm --filter didcomm-mediator-service …` is ambiguous and pnpm just prints its help. Working form:

```yaml
entrypoint: ["sh", "-c"]
# One-element LIST. A plain string `command:` is split into words by Compose, so `sh -c`
# runs only "cd" and exits 0 having migrated nothing.
command: ['cd /app/apps/mediator && pnpm run drizzle:migrate:postgres --database-url "$$STORAGE__DATABASE_URL"']
```

- **The string form of `command:` is a silent no-op (confirmed, Phase 1).** On staging, Docker recorded `Cmd=["cd","/app/apps/mediator"]`; the container exited 0 with no output, no tables were created, and both mediator replicas crash-looped on the missing `StorageVersion` table. The list form above applies all three schema bundles (core, didcomm, mediator). This is very likely the same symptom Phase 0 attributed to a missing `--database-url`.
- **Pass `--database-url` anyway.** It is what the working command uses; the variant without it was never isolated.
- **Health-check the tables, not the exit code.** `infra/scripts/check-mediator-tables.sh` fails the deploy unless `drizzle."StorageVersion"` and `drizzle."PushNotificationsFcm"` exist (`--after-start` also checks `message_pickup.queued_message` and `live_session`).
- **Start replicas one at a time on a fresh database.** Two replicas provisioning the Askar store at once race on `CREATE SCHEMA` (`duplicate key value violates unique constraint 'pg_namespace_nspname_index'`). Use `depends_on: service_healthy` from the second replica to the first.
- **Pre-bake pnpm** (`FROM mediator:<sha>` + `corepack install --global pnpm@10.7.0`, `COREPACK_ENABLE_NETWORK=0`) so the migration needs no registry access at deploy time; see `infra/staging/mediator/Dockerfile.migrate`.
- pnpm inside the image is provided by corepack and **downloaded at run time**, so the migration container needs outbound npm registry access unless pnpm is pre-baked.

Moving the mediator to Credo 0.7 means building this repository ourselves (§12.8).

### 7.4 Ledger

```
bcgov/von-network                      # dev pool + ledger browser (start with an explicit LAN IP on Docker Desktop)
hyperledger-indy/indy-node-container   # production validator images
hyperledger/indy-node-monitor          # validator-info collection, Grafana dashboards
```

`bcgov/indy-tails-server` is not needed in v1 (§2.2).

---

## 8. Packages — iOS SDK

**Not yet tested — the Swift pass of Phase 0 is outstanding.** Everything in this section comes from the project README.

```
LF-Decentralized-Trust-labs/aries-framework-swift   # fork this
LF-Decentralized-Trust-labs/aries-uniffi-wrappers   # AriesAskar, AnonCreds, IndyVdr
```

Swift Package Manager. Minimum iOS 15.0 (imposed by the WebSockets dependency).

Transitive dependencies pulled in by the framework: CollectionConcurrencyKit, BigInt, Base58Swift, Semaphore, Criollo (tests only).

The Swift sample app configures `mediatorPickupStrategy: .Implicit`. Given §2.7.3, the Swift pass must establish whether the framework supports pickup v1 and whether it has the same `label` and DIDDoc-context problems as Kotlin (§2.7.4).

**Bonus capability:** the Swift framework supports phone-to-phone DIDComm over Bluetooth (`ble://` endpoints), requiring `NSBluetoothAlwaysUsageDescription` in Info.plist. Not needed for v1 but worth knowing.

---

## 9. Packages — Android SDK

```
LF-Decentralized-Trust-labs/aries-framework-kotlin  # fork this
LF-Decentralized-Trust-labs/aries-uniffi-wrappers
```

Published to GitHub Packages as `org.hyperledger:aries-framework-kotlin`, with UniFFI wrappers as `org.hyperledger:anoncreds_uniffi`, `org.hyperledger:indy_vdr_uniffi`, `org.hyperledger:askar_uniffi`. `minSdk 24` (Android 7.0); the sample compiles against SDK 33 and builds with its Gradle 8.0 wrapper and JDK 17.

> **Blocking issue:** GitHub Packages requires every consumer to configure a GitHub token with `read:packages`. We cannot ask our customers to do that. Since we are forking anyway, republish to Maven Central or our own repository under our own coordinates. Resolve this before the first customer integration. (A *source* build of the framework, as the sample app does, needs no token — this only affects consumers of the published artifact.)

**Binary size (confirmed).** The default build packages native libraries for seven ABIs (arm64-v8a, armeabi, armeabi-v7a, mips, mips64, x86, x86_64):

| Build | Debug APK |
|---|---|
| Default | **165.8 MB** |
| `splits { abi { enable true; reset(); include "arm64-v8a"; universalApk false } }` | **51.7 MB** |

**`ndk { abiFilters … }` has no effect**, because the UniFFI libraries arrive prebuilt inside AARs. Use ABI splits or App Bundles.

**Rig note:** some OEM builds (MIUI observed) reject `adb install` with `INSTALL_FAILED_VERIFICATION_FAILURE`; `adb shell settings put global verifier_verify_adb_installs 0` clears it for development devices.

---

## 10. Work breakdown

### Phase 0 — Spike — **Android: conditional pass**

Rig, scripts and full evidence: `phase0/` and [`../../phase0/findings.md`](../../phase0/findings.md).

- [x] Local Indy pool (`von-network`), endorser DID, schema and credential definition published from Credo 0.7
- [x] Credo-to-Credo control round trip, v1 end to end (establishes a baseline before involving native code)
- [x] Mediator deployed locally (Docker Compose, Postgres, Redis, Drizzle)
- [x] Credo holder behind the mediator, full round trip
- [x] `aries-framework-kotlin` sample app on a physical device: connect, issue, verify via the mediator (with the two fork changes in §2.7.4)
- [ ] Repeat with `aries-framework-swift` — **outstanding; needs a Mac**

Answers:

- [x] **Protocol versions** — v1 negotiated end to end, on Credo and on device; needs v1 registered explicitly and `useDidSovPrefixWhereAllowed: true` (§2.7.1)
- [x] **Identifier format** — legacy unqualified mandatory for v1; enforced by Credo itself (§2.7.2)
- [x] **Pickup strategy** — Kotlin supports only `PickUpV1` and `Implicit`; `PickUpV1` + `QueueAndLiveModeDelivery` is the working combination (§2.7.3)
- [x] **Offline delivery** — works with that combination on device; lost with `DirectDelivery` (§2.7.3)
- [~] **Ledger reachability from mobile** — open on home Wi-Fi and one cellular carrier (TCP); **restrictive corporate Wi-Fi outstanding** (§4.6)
- [—] **Revocation round trip** — removed; revocation is out of v1 (§12.3)
- [ ] **Feature parity** — pending the Swift pass
- [x] **Push token path** — no push protocol in the holder; platform owns the token mapping (§4.8)
- [x] **Runtime genesis** — framework takes a file path; fetch-and-cache confirmed on device (§4.3)

- [~] **Gate:** conditional pass. Phase 1 may start. **Phase 5 SDK work stays gated on the Swift pass**, and the corporate-network reachability test should close before §12.1 commits a ledger topology.

### Phase 1 — Infrastructure

Status and evidence: [`5-phase-1.md`](5-phase-1.md) (plan), [`6-phase-1-findings.md`](6-phase-1-findings.md) (results).

- [—] Decide node count and operators (§12.1): **deferred**; staging is genesis-URL-driven so the switch is a config change
- [x] Stand up dev Indy pool (`von-network`, explicit host IP)
- [x] Stand up **staging** pool: von-network on a cloud VM behind 1:1 NAT, public IP in genesis, node-to-node ports firewalled via `DOCKER-USER` (a wrong allow-rule broke consensus silently while reads worked). Production pool not started (§12.1)
- [~] Corporate-network reachability test: **not run (no access); accepted risk.** `indy-vdr-proxy` deployed on 443 and the holder change assessed as small (§12.9)
- [x] Genesis distribution endpoint: HTTPS, versioned and immutable (`/v1/`), cacheable, sha256 + minisign signature
- [x] Endorser DID created with its key in Postgres-backed Askar; TAA flow documented (not run: von-network has no TAA). Trustee is von-network's built-in one on staging
- [x] Mediator build decided: published 0.6 image pinned by SHA (§12.8)
- [x] Deploy mediator: Postgres (four databases incl. endorser), Redis cache, pre-baked migration image with the **list-form** command and table health check, `AGENT_PORT`, `AGENT_ENDPOINTS` wss-first, `QueueAndLiveModeDelivery`, two replicas with staggered start. **Multi-instance delivery `none`, not Redis** (§2.3)
- [x] Verify the webhook fires, with TLS endpoints: fires only with multi-instance `none` + Firebase placeholder; one per queued message; body has no `fcmToken` (§2.3)
- [~] Mediator ingress:
  - `/invite` blocked at the edge (the mediator serves its invitation unauthenticated).
  - **Per-IP rate limiting live** (custom Caddy build with caddy-ratelimit; burst verified 429 after the limit).
  - **Mediation-record spike alerting live.**
  - Per-user invitation gating **not designed yet**. Constraint: the edge cannot tell a mediation request from a forward, so it needs a mediator-side hook or a separate onboarding endpoint (Phase 3).
- [~] Monitoring: Prometheus, Alertmanager, Grafana, node/cAdvisor/blackbox/postgres exporters, queue metrics, TLS expiry and a **ledger write probe** (reachability alone misses consensus loss). Alert email pending the owner's Gmail app password. `indy-node-monitor` and dashboards **not done**; alerts not yet fired deliberately
- [x] Secrets: SOPS + age (encrypted env files in the repo, age key on the VM), minisign key, `deploy.sh` decrypts to tmpfs only. **Owner must back up the age key**
- [x] Nightly age-encrypted Postgres backups (VM-local by decision) and a restore drill, including reopening the restored endorser store
- [x] End-to-end smoke over TLS:
  - `smoke:credo` passed (v1 only, cross-replica delivery). A Credo holder must use HTTP towards a ws-first mediator (Credo WS client limitation, findings W8).
  - **`smoke:android` passed.** The native Kotlin holder, `PickUpV1` over `wss://` through the staging edge, completed a live credential, a credential offered while the app was force-stopped (collected 4.6 s after reopen) and a proof with `isVerified=true`, all v1. There was one webhook per queued message.

### Phase 2 — Agent services — **deployed on staging**

Plan: [`7-phase-2.md`](7-phase-2.md); evidence: [`8-phase-2-findings.md`](8-phase-2-findings.md); code: `services/` (`credo-base`, `agent-service`, `endorser-service`), `infra/staging/compose.agent.yml`.

- [x] `agent-service`: one Credo 0.7 root agent, Askar on Postgres with **one profile per tenant** (`ProfilePerWallet`; Credo's default is a database per tenant), AnonCreds, Indy VDR, `@credo-ts/tenants`. Bindings imported first, plain `node`, pino-backed Credo logger, `tsc --noEmit` as a gate. Provisioning is a separate one-shot job (concurrent provisioning races)
- [x] HTTP inbound + HTTP and WS outbound; public endpoint `https://agent.<domain>` through Caddy (POST `/` and GET `/readyz` only); internal API on a private port for the platform API
- [x] Tenant provisioning as a resumable state machine: create tenant → tenant creates its `did:indy` key → **endorser-service** signs a role-less NYM → tenant submits → `GET_NYM` check. Tenant DIDs have no ledger role
- [x] Schema publishing through the author/endorser flow; `expiresAt` is mandatory in every schema and refused otherwise
- [x] Credential definitions with `supportRevocation: false`; both identifier forms stored; the action-state credential definition is persisted so a retry never regenerates keys (§ findings T2)
- [x] v1 protocols only, `useDidSovPrefixWhereAllowed: true`, connections auto-accepted, credential/proof steps `ContentApproved`
- [x] Offers and proof restrictions take unqualified ids only (qualified → 400); every proof request carries an `expiresAt >=` predicate the caller cannot remove; an attribute cannot be both revealed and predicated (AnonCreds rule)
- [x] Event listener → `outbox` table (connection, credential, proof transitions; thread id; correlation id). Subscribes via Credo's enum constants: the connection event string is `ConnectionStateChanged`, without the `DidComm` prefix
- [x] Correlation ids on every row of an exchange, including the first event Credo emits inside the API call (announce/consume handshake, findings A5–A7)
- [~] Wire-level message-type logging: available in the smoke tooling; not enabled in the service (Credo debug logging covers it through pino)
- [x] Schema versioning: new version = new schema + cred def; deprecation blocks new offers, proofs keep accepting old cred defs
- [x] Graceful shutdown: readiness 503 → close internal API → wait for in-flight DIDComm messages (deadline) → `agent.shutdown()` **once**. Never stop Credo transports separately. Verified in the container
- [x] Stuck-exchange reconciliation (a failed send desynchronises both sides permanently and nothing retries): waiting records past a TTL are abandoned with an outbox row
- [x] Versions pinned per component: agents 0.7.0, mediator image `375518d` (Credo 0.6.0), Kotlin fork commit; interop verified Credo holder ↔ mediator ↔ tenant issuer on staging
- [x] Restore drill for the agent databases (root store reopened from backup with the real key)
- [x] `smoke:tenant-android` on the phone against a tenant issuer: live, offline (3.1 s after reopen) and a proof with the expiry predicate, all v1. It exposed a mediator bug (below), now patched

**Also new:** `endorser-service` (§12.10). **Multi-tenant traps** (findings T1): Credo's default cache breaks the second tenant (use `InMemoryLruCache`, never `useCachedStorageService`); inbound messages are processed one at a time across all tenants by default.

### Phase 3 — Platform API — **deployed on staging**

Plan: [`9-phase-3.md`](9-phase-3.md); evidence: [`10-phase-3-findings.md`](10-phase-3-findings.md); code: `services/platform-api/`, `infra/staging/compose.platform.yml`, runbook `infra/runbooks/platform-api.md`.

- [x] Auth: API keys per tenant (sha256 stored, shown once); operator bootstrap routes behind an admin token, blocked at the edge; agent-service internal API now token-gated
- [x] `GET /v1/wallet/mediator-invitation` — wallet-token auth, single-use invitation per wallet minted by the patched mediator (§2.3, §12.8, §12.13)
- [x] `GET /v1/ledger` — genesis URL, sha256, minisign signature URL and public key, vdr proxy (the file stays on the versioned genesis host)
- [—] `POST /devices` — dropped: wake-ups are relayed to the customer (§12.12)
- [x] `POST /v1/connections/invitations` — single- and multi-use; `GET /v1/connections`, `/{id}`
- [x] `POST /v1/credentials/offer` (async, 202) and `GET /v1/credentials`, `/{id}` from mirror tables fed by agent-service's outbox
- [x] Proof templates (by schema name across versions, or by cred def id) and `POST /v1/proofs/request`, `GET /v1/proofs/{id}` with `verified` + `disclosed`
- [x] Webhooks: HMAC-signed, Postgres-queued, exponential backoff, dead-letter with customer retry; `Idempotency-Key` on POSTs
- [x] Mediator webhook receiver → wallet via `out_of_band_id` → debounced `wallet.sync_requested` (§4.8)
- [x] OpenAPI (`/openapi.json`, committed) and integration guide (`services/platform-api/docs/api.md`)
- [x] `smoke:platform-credo` PASSED over the public API
- [x] `smoke:platform-android` PASSED on the phone (gate): per-wallet invitation, live + offline + template proof, wake-up from the offline message

Original checklist:

- [ ] Auth: API keys scoped per tenant
- [ ] `GET /mediator/invitation` — authenticated, short-lived, per-user mediator invitation (do not ship a static one; see §2.3)
- [ ] `GET /ledger/genesis` — versioned, cacheable genesis file endpoint for the SDK
- [ ] `POST /devices` (or equivalent) — register/refresh a push token against the wallet's mediator connection (§4.8)
- [ ] `POST /connections/invitation` — returns OOB URL + QR payload; support both single-use and multi-use invitations (kiosk and web-embed use cases need multi-use)
- [ ] `GET /connections`, `GET /connections/{id}`
- [ ] `POST /credentials/offer` — async, returns record ID
- [ ] `GET /credentials/{id}` — state polling
- [ ] Proof request template CRUD
- [ ] `POST /proofs/request` — async, returns record ID
- [ ] `GET /proofs/{id}` — result + disclosed attributes
- [ ] Webhook delivery: signed payloads, exponential backoff, dead-letter queue
- [ ] Mediator webhook receiver → token lookup by `connectionId` → de-duplicated FCM/APNs dispatch; network-restricted or authenticated (§6)
- [ ] OpenAPI spec published for customers

### Phase 4 — Console — **deployed on staging (4a + 4b)**

Plan: [`11-phase-4.md`](11-phase-4.md); evidence: [`12-phase-4-findings.md`](12-phase-4-findings.md); code: `console/` (TanStack Start + Better Auth, own package and image), platform-api additions; `infra/staging/compose.console.yml`; runbook `infra/runbooks/console.md`.

One app, two roles: **platform operator** (all tenants) and **tenant member** (own tenant), because the product is SaaS and self-hostable (§12.15).

- [x] platform-api console scope + `console_audit` + console-only API-key routes + cross-tenant operator views (`/admin/overview`, `/admin/webhook-deliveries`, `/admin/audit`)
- [x] Auth: invite-only accounts, 2FA required (TOTP or email OTP; operators TOTP-only), sessions, password links by mail (§12.14)
- [x] **Stage 4a, operator console:** tenants (create, onboarding retry, console organization + owner), API keys (shown once), catalogue with both identifier forms, proof templates (read), credential/connection/proof/wallet browsers, webhook endpoint + delivery log with body view and retry, dead deliveries across tenants, audit log, operator accounts
- [x] **Stage 4b, tenant portal (built, local Playwright 4/4):** `/t/$orgSlug/*` with members and invitations (invite mail → account → 2FA), self-service API keys, schema/cred-def publishing (`expiresAt` always appended), proof template builder (expiry predicate enforced, client mirror of the platform rules), connection invitation with QR, browsers, webhook configuration and delivery log; owner/admin/member roles checked per request
- [x] Staging: console deployed; `smoke:platform-credo` PASSED with a console-created key; Playwright staging specs pass for the operator console and the tenant portal (catalogue, template builder, exchanges, webhooks, API keys, members, audit)
- [ ] Left for later: restore drill of the `console` database; invited-member acceptance through real SMTP on staging; operator 12 h session cap observed

Original checklist: tenant management; catalogue (both identifier forms); proof template builder (expiry predicate enforced); credential and connection browser; webhook delivery log.

### Phase 5 — Holder SDK (gated on the Swift pass)

- [ ] Fork both frameworks; set up our own build and release pipeline
- [ ] Apply the Kotlin fork changes: optional `OutOfBandInvitation.label`; DIDDoc `@context` (needed while the mediator is 0.6) (§2.7.4)
- [ ] Establish the equivalent Swift changes and pickup support in the Swift pass
- [ ] **Resolve Android distribution** (republish to our own Maven repo)
- [ ] Design a single public API surface, identical on both platforms. Customers must never see Aries concepts. Target shape:
  - `initialize(config)`
  - `connect(invitationUrl)`
  - `credentials()` / `credential(id)`
  - `pendingOffers()` / `acceptOffer(id)` / `declineOffer(id)`
  - `pendingProofRequests()` / `respondToProofRequest(id, selection)` / `declineProofRequest(id)`
  - `registerPushToken(token)` — passed to the platform API against the mediator connection
  - `sync()` — called by the host app from its push handler; triggers an immediate pickup
  - delegate/listener for state changes
- [ ] Pin `mediatorPickupStrategy = PickUpV1`; expose the polling interval as internal configuration
- [ ] Genesis file fetched from our server and cached to a file, **not** compiled into the binary (no framework change needed)
- [ ] Mediator connection handled automatically on first init
- [ ] Wallet key generation and Keychain/Keystore storage
- [ ] Binary size: Android **ABI splits or App Bundles** (not `abiFilters`); strip unused architectures on iOS
- [ ] Parity test suite running both SDKs against the same Credo issuer in CI, including the offline-delivery scenario
- [ ] Integration guide + sample app per platform

### Phase 6 — Hardening

- [ ] Load test the mediator with the real profile: N open wallets each polling every 10 s (`PickUpV1`), plus one webhook per queued message
- [ ] Failover test: kill one Indy validator, confirm reads and writes continue
- [ ] Multi-instance mediator: confirm queued messages and webhooks survive instance loss
- [ ] Key rotation runbook
- [ ] Disaster recovery: what happens if we lose the Endorser key, a wallet database, the mediator queue
- [ ] Document the wallet-recovery and no-revocation stories for customers

---

## 11. Known traps

1. **Genesis file in the app binary.** If it is compiled in, changing validators means an app update for every customer's users. Fetch and cache it instead. *Phase 0: the Kotlin framework takes a file path, so this costs nothing — the sample app's `assets.open()` copy is the only thing to avoid copying.*

2. **Native binding version mismatch — and a look-alike.** `@credo-ts/*` packages must match their Askar/AnonCreds/Indy VDR binding versions exactly (§7.1). Separately, importing a Credo package *before* the binding package produces an error that looks identical to a mismatch (§7.1).

3. **Treating issuance as synchronous.** DIDComm is asynchronous. The offer goes out, the response may arrive hours later. Build commands-in/events-out from day one or the architecture will fight you.

4. **Tails file URL is immutable** *(revocation only — not in v1).* Relevant when revocation is added: it is written into the revocation registry definition and cannot change.

5. **Platform drift between iOS and Android SDKs.** Two independent codebases will diverge. Define one supported protocol matrix and test both against it in CI.

6. **Revocation registry capacity** *(revocation only — not in v1).*

7. **No revocation means no invalidation.** A credential without an expiry predicate enforced by every verifier is valid forever (§4.7). Enforce the expiry predicate in the template layer so a customer cannot forget it.

8. **Mediator is a single point of failure** for every mobile user. Multi-instance with Redis streams from the start, not as an optimisation later — and re-verify webhook behaviour in that mode (§2.3).

9. **Askar wallet lock on unclean shutdown.** Agents must close gracefully. Add signal handlers, and drain in-flight messages before closing the store.

10. **Labs-stage frameworks.** `aries-framework-swift` and `aries-framework-kotlin` are incubation projects with small maintainer bases. Budget for maintaining forks — this is not optional. Phase 0 already needed two fork changes before the Kotlin holder could connect.

11. **Protocol version mismatch (v1 vs v2).** Credo 0.7 registers only v2 unless told otherwise; the native holders speak only v1. Symptom is a silent stall. See §2.7.1.

12. **Qualified identifiers in v1 payloads.** The registration API returns `did:indy` IDs; v1 refuses them. The holder sends a problem report and the issuer's record sits at `offer-sent` with no error. See §2.7.2.

13. **Open mediation.** Confirmed. The mediator will relay for anyone who has its invitation. See §2.3.

14. **Schema is immutable.** A customer asking to "just add one field" means a new schema version, a new credential definition, and proof templates that accept both. Design for it on day one, not when the first request lands.

15. **Indy client port on mobile networks.** Non-standard ports. Open on the consumer networks tested; corporate networks not yet tested. See §4.6.

16. **Debugging across the mediator is hard.** A message that vanishes between issuer and holder has several resting places: issuer outbound, mediator queue, mediator live-session lookup, WebSocket, holder inbound processing. Every Phase 0 stall produced *no error anywhere*. Without correlation IDs, a working logger (Credo's default is silent, §7.1) and message-type logging at each hop, support will be guesswork.

17. **Multi-tenancy shares one endpoint.** All tenants' connections route through the same agent URL. Customers who want their own branded DIDComm endpoint cannot have one without a separate agent deployment. Set expectations in the sales conversation.

18. **Mediator forwarding strategy vs holder pickup.** `QueueAndLiveModeDelivery` never delivers to an implicit-pickup holder; `DirectDelivery` (the mediator's *default*) loses offline messages. Only `PickUpV1` + `QueueAndLiveModeDelivery` works both ways. See §2.7.3.

19. **`AGENT_ENDPOINTS` order and `AGENT_PORT`.** List the WebSocket endpoint first or the holder's mediation grant is lost; set `AGENT_PORT` or the mediator listens on 3110 while advertising something else. Both fail with a healthy-looking container. See §2.3.

20. **Mediator deployment commands in older docs do not work.** No `latest` tag; the `pnpm --filter` migration command is ambiguous; the migration silently no-ops without `--database-url`; the pickup-queue host rejects `host:port`. See §2.3 and §7.3.

21. **Stock holder vs stock mediator.** The mediator's invitation has no `label`; the Kotlin holder requires one. A Credo 0.6 mediator rejects the Kotlin holder's DIDDoc context. Neither produces a useful error on the holder side. See §2.7.4.

22. **The mediator webhook does not always fire.** In single-instance mode it needs a Firebase block configured; in any mode it fires for every queued message and carries no device token for our holder. See §2.3 and §4.8.

23. **Credo 0.7 API renames.** Class names, transport names, event names and event payload keys all changed; connection auto-accept is configured separately from credential/proof auto-accept. Code copied from pre-0.7 examples compiles poorly or subscribes to events that never fire. See §2.7.1.

24. **The mediator's Postgres queue re-delivers pickup-v1 messages forever** (Phase 2). The first delivery looks perfect, so every earlier smoke passed; the holder then receives the same messages on every poll and answers duplicate proof requests. Patched in `12id/mediator:375518d-p1`; unpatched upstream as of 2026-09-13. See §12.8.

25. **A stuck exchange never recovers by itself** (Phase 2 T3a). A send that fails, or a crash between two protocol steps, leaves the holder and issuer in different states with no retry on either side. The agent-service abandons waiting records after a TTL and the platform must re-offer on a new thread.

26. **The default Credo cache breaks the second tenant** (Phase 2 T1). `SingleContextStorageLruCache` binds to the first agent context; register `InMemoryLruCache`, and never enable `useCachedStorageService` with it (connection records would be cached under keys without a tenant).

27. **The first Credo state event fires inside the API call** (Phase 2). `offer-sent` / `request-sent` are emitted before `offerCredential` / `requestProof` return, so anything stamped onto the record afterwards is missing from the first event. Announce ids before the call and let the listener stamp the record.

28. **An attribute cannot be both revealed and predicated** in one v1 proof request (AnonCreds). With a mandatory `expiresAt` predicate, `expiresAt` can never be disclosed.

29. **Single-file bind mounts ignore a replaced file** (Phase 3). Syncing the Caddyfile by extracting over it created a new inode; `caddy reload` re-read the old content and the new sites silently did not exist. Recreate the container after syncing.

30. **The mediator webhook fires during mediation setup** (Phase 3). A fresh wallet triggers `wallet.sync_requested` before it has any customer connection. Customers must treat the event as "sync now", not "a credential arrived".

32. **A form submitted before hydration sends its fields as a GET query string** (Phase 4). The first Playwright run put the password in the URL. Every console form uses `method="post"` and disables its submit until `useHydrated()`.

33. **Defining `src/start.ts` disables TanStack Start's built-in CSRF middleware** (Phase 4). Register `createCsrfMiddleware` yourself, with the public origin as matcher (the internal request URL differs behind the proxy).

34. **Better Auth offers email OTP to every 2FA user once `sendOTP` is configured** (Phase 4). Operator TOTP-only needs an after-hook that deletes sessions created through `/two-factor/verify-otp` for operators, plus middleware requiring a verified TOTP secret.

35. **Idempotency replays store response bodies** (Phase 3/4). A route that returns a secret once (`POST /v1/api-keys`) must opt out (`config: { idempotency: false }`); `POST /v1/wallets` still stores the plaintext wallet token for 24 h (open decision).

36. **Controls outside a form are dead before hydration, and a changed `<select>` keeps its new value** (Phase 4). The page shows a change that was never sent. Disable every action control, not only submits, until `useHydrated()`.

37. **Better Auth rate limits sign-in to 3 requests per 10 s per IP, stored in the database** (Phase 4). Tests from one machine share the budget across files; wait out the window rather than disabling the limit.

31. **A used mediator invitation fails silently** (Phase 3, confirmed on the phone). After an app data wipe, the holder presents the wallet's spent single-use invitation; the mediator logs `Out-of-band record has been already processed` and sends nothing back, and the Kotlin holder reports only `Connection to the mediator timed out` after 20 s. The SDK must fetch a new invitation from `GET /v1/wallet/mediator-invitation` and retry on that timeout (Phase 5).

---

## 12. Decisions

### 12.1 Indy node count and operators — deferred (Phase 1 decision)

**Status after Phase 1:** deliberately deferred. Staging runs von-network (4 nodes on one VM) behind a signed, versioned genesis URL (`https://genesis.<domain>/v1/pool_transactions_genesis`, minisign-signed). Every agent, tool and (later) the SDK is configured from that URL plus a sha256, so moving to option (a), (b) or (c) below means publishing a new genesis version and updating one pinned URL/hash, not rebuilding components (`infra/runbooks/genesis-rotation.md`). Decide before any production deployment; the §12.9 hedge is already built, so corporate-network blocking no longer gates this decision.

Original framing:

If we run all validators ourselves, we have an append-only database with blockchain operating costs, not a decentralised ledger. Self-hosting only earns its keep when validators are operated by **different organisations**.

Options:
- **(a)** Run 4 nodes ourselves — simplest, honest about being centralised
- **(b)** Recruit customers or partners as stewards — real decentralisation, significant governance work
- **(c)** Use a third-party permissioned network — no ops burden, external dependency

**Must be decided before Phase 1.** Close the corporate-network reachability test (§4.6) first: if client ports are widely blocked, the proxy requirement affects which option is practical.

### 12.2 Wallet recovery — open

Accept loss and re-issue, or build encrypted backup? Affects SDK API surface. **Decide before Phase 5.**

### 12.3 Revocation in v1 — decided: not in v1

Decided before Phase 0. Consequences now designed in: no tails server; credential definitions published with `supportRevocation: false` (**cannot be retrofitted** — adding revocation later means new credential definitions and re-issuance); short-lived credentials implemented as an integer expiry attribute with a mandatory verifier predicate (§4.7); customer-facing documentation that credentials cannot be invalidated early (§5.3). Revisit if a customer needs early invalidation.

### 12.4 Issuer/verifier deployment split — decided: one codebase, one deployment

**Decision (Phase 2 planning):** `agent-service` issues and verifies in one process (`AGENT_ROLES=issuer,verifier`, splittable later). DIDComm connections live in the tenant's wallet inside one agent; separate issuer and verifier processes would need either two connections per end user or a shared tenant store that Credo does not coordinate. Revisit if verification load ever starves issuance (Phase 6 load test).

### 12.5 Identifier format — decided: legacy unqualified on the wire

Phase 0 result (§2.7.2). The issuer DID may be `did:indy`; schema and credential-definition identifiers in offers and proof requests must be legacy unqualified for as long as issue-credential/present-proof v1 is used, i.e. as long as the holders are AIP 1.0. Both forms are stored. This narrows interoperability with newer agents that expect qualified identifiers; revisit only together with a move to v2 protocols.

### 12.6 SDK development start date — decided: Android in parallel with Phase 2

**Decision (Phase 2 planning):** Android SDK work starts now, in its own plan; iOS stays gated on the Swift pass. Integration point with Phase 2 is `smoke:tenant-android` (a tenant issuer on staging, still to be run on the device). §12.2 (wallet recovery) must be decided before the SDK's public API is frozen.

### 12.7 Future OpenID4VC support — unchanged

Not in v1 scope, but keep the issuance API abstracted at the platform layer so a second credential format can be added without rewriting customer-facing endpoints.

### 12.8 Mediator Credo line — decided: published 0.6 image, pinned by SHA

The published mediator image is Credo 0.6.0; our agents are 0.7.0. Upstream `main` was still at `375518d` (December 2025) with no 0.7 build when Phase 1 started.

**Decision (Phase 1): (a), `ghcr.io/openwallet-foundation/didcomm-mediator-credo/mediator:375518d`.** Upstream maintains the code; the one-line DIDDoc-context change stays in both holder forks, which we maintain anyway (§2.7.4). Revisit when upstream publishes a 0.7 image.

Staging runs two replicas of this image with a pre-baked migration image (§7.3). A Credo 0.7 issuer and a Credo 0.7 holder interoperate with it end to end over TLS (Phase 1 `smoke:credo`).

**Amended in Phase 3: `12id/mediator:375518d-p2`** adds a second patched file, `apps/mediator/build/agent.js`, with an internal `POST /admin/invitations` route (token-guarded, absent without `ADMIN_API_TOKEN`, 404 at the edge) that mints single-use invitations for the platform API.

**Amended in Phase 2: the image is now `12id/mediator:375518d-p1`**, the pinned image plus one patched file. The Postgres pickup queue never deleted messages handed to a **pickup-v1** holder (`takeFromQueue({ deleteMessages: true })` only selected), so the native holder was re-sent every message on every poll and answered every copy of a proof request. Upstream `main` has the same code. The patch (`infra/staging/mediator/Dockerfile.patched`) replaces that branch with an atomic delete-on-handover. File it upstream; re-check on every mediator upgrade. `8-phase-2-findings.md` has the evidence.

The rejected option (b), porting the mediator to 0.7 ourselves, is roughly 3,700 lines of TypeScript with 48 files touching Credo, plus permanent ownership of image builds and security patching.

### 12.9 Corporate-network ledger access — accepted risk, hedge deployed

The restrictive corporate Wi-Fi test (§4.6) could not be run: no access. **Treated as an accepted open risk**, with the fallback built so it is not a blocker if the risk materialises:
- **`indy-vdr-proxy` runs on staging** at `https://vdr.<domain>` on 443, built from `hyperledger-indy/indy-vdr` v0.4.5 (no official binary or image exists). The edge allows GET/HEAD only; the proxy's `POST /submit` write relay is blocked.
- **The proxy returns the pool's raw reply envelope, including the state proof** (verified for NYM and CLAIM_DEF reads).
- **Holder change is small (Kotlin, source read):** every ledger read goes through `LedgerService.submitReadRequest`, and v1 needs only `getSchema` and `getCredentialDefinition`, whose parsing needs no change against the proxy. Estimate: 1–2 days per platform; Swift not yet read.
- **Trade-off:** reads through the proxy trust our TLS endpoint unless the fork verifies the included state proof.

Re-run the §4.6 probe as soon as a corporate network is available; build the fork change only if client ports turn out to be blocked.

### 12.10 Endorser key placement — decided: separate internal endorser-service (new, Phase 2)

The endorser key is the most valuable secret in the system (§6). Phase 2 keeps it out of the process that accepts internet DIDComm traffic:
- `endorser-service` opens the Phase 1 endorser Askar store and refuses to start unless it holds `ENDORSER_DID`. It is on a private Docker network only, behind a shared token.
- It **signs and never submits**: role-less NYMs authored in its own name for DIDs the agent-service bound to a tenant (first binding wins, never rebound), and SCHEMA / CLAIM_DEF transactions authored by that tenant DID. Everything else is refused. Credo itself would sign any transaction whose endorser field matches, so this policy is entirely ours.
- Every decision, signed or refused, is audited with the sha256 of the request; a signature is not released if the audit write fails.

Consequence: tenant DIDs inherit the endorser's `did:indy` namespace, so the production namespace is fixed by the production endorser (with §12.1).

### 12.11 HTTP framework — decided: Fastify for our APIs (new, Phase 2)

Credo's `DidCommHttpInboundTransport` is Express-only, so the public DIDComm port stays on Credo's stock Express transport, untouched. Our own APIs (agent-service internal API now, platform API in Phase 3) use Fastify with zod schemas: request validation and response serialization are enforced by the framework, and undeclared response fields are stripped. A shared error handler answers server errors generically (a local run leaked SQL text in a 500 body before it existed).

---

### 12.12 Push wake-up path — decided: relay to the customer (new, Phase 3)

The platform never sends FCM/APNs pushes and stores no device tokens. The SDK is embedded in the customer's app, so push credentials and tokens belong to the customer's own Firebase/Apple projects. The mediator webhook is mapped to a wallet and relayed as a signed `wallet.sync_requested` webhook; the customer pushes its app, which calls `sync()`. Revisit if a customer cannot run push infrastructure (option: per-tenant FCM credentials uploaded to the platform).

### 12.13 Wallet authentication — decided: per-wallet tokens via the customer backend (new, Phase 3)

`POST /v1/wallets` (API key) returns a `walletToken` that the customer backend hands to its app. It authenticates the SDK-facing routes, is revocable per installation, and never links a wallet to an end-user identity on the platform side. A per-tenant key embedded in the app was rejected: extractable, and it leaves wallets anonymous, which would break the wake-up mapping.

### 12.14 Console authentication — decided: Better Auth, invite-only, 2FA for everyone (new, Phase 4)

The console (`console/`) uses Better Auth with the organization (tenant membership and roles), two-factor and admin (operator role) plugins, in its own `console` database. There is no public sign-up: operators come from the CLI or an operator's invitation, tenant owners are created by an operator, members by an owner's invitation. 2FA is mandatory (enforced by the console middleware; Better Auth makes it opt-in) with TOTP or email OTP; **operators must use TOTP** because a mailbox compromise would otherwise turn password reset plus email OTP into a single factor. The console reaches platform-api only through the **console scope** (`x-console-token` + actor/role/tenant), never through customer API keys and never by reading platform-api's database. Better Auth's api-key plugin is not used.

### 12.15 SaaS and self-hosting — decided: both, console self-host-ready first (new, Phase 4)

The product is offered as SaaS and will also be self-hostable by an organization. That is why the console has two roles (operators across tenants for us or a self-hoster's admins; tenant members for SaaS customers). Phase 4 keeps the console free of dependencies a self-hoster cannot have (no Google allowlist, no fixed IPs, everything configured by environment, mail through any SMTP). Packaging the whole stack (ledger, patched mediator, endorser, genesis signing, upgrades) for self-hosters is a later phase.

## Appendix A — Repository reference

| Component | Repository |
|---|---|
| Credo framework | `openwallet-foundation/credo-ts` |
| Credo extensions (REST, hooks) | `openwallet-foundation/credo-ts-ext` |
| REST controller (alternative) | `credebl/credo-controller` |
| Mediator | `openwallet-foundation/didcomm-mediator-credo` |
| iOS holder framework | `LF-Decentralized-Trust-labs/aries-framework-swift` |
| Android holder framework | `LF-Decentralized-Trust-labs/aries-framework-kotlin` |
| Native crypto bindings | `LF-Decentralized-Trust-labs/aries-uniffi-wrappers` |
| Indy validator | `hyperledger-indy/indy-node` |
| Indy containers | `hyperledger-indy/indy-node-container` |
| Dev ledger | `bcgov/von-network` |
| Ledger monitoring | `hyperledger/indy-node-monitor` |
| Tails server (post-v1) | `bcgov/indy-tails-server` |
| Reference wallet (RN, for UX study) | `openwallet-foundation/bifold-wallet` |

## Appendix B — Documentation

- Credo docs: `https://credo.js.org`
- Credo mediation tutorial: `https://credo.js.org/guides/tutorials/mediation`
- Credo supported features: `https://credo.js.org/guides/features`
- AnonCreds specification: `https://hyperledger.github.io/anoncreds-spec/`
- Aries RFCs: `https://hyperledger.github.io/aries-rfcs/latest/`
- Interop test results: `https://aries-interop.info`
- Public test ledger used for reachability testing: BCovrin Test, genesis at `https://test.bcovrin.vonx.io/genesis`

## Appendix C — Phase 0 rig

Throwaway, but re-runnable, and the fastest way to reproduce any finding above.

| Path | Contents |
|---|---|
| `phase0/findings.md` | Evidence log: every run, error text and source reference behind this revision |
| `phase0/von-network/` | Dev ledger (start with `./manage start <LAN-IP>`) |
| `phase0/mediator/docker-compose.yml` | Mediator stack with the working configuration |
| `phase0/agent/src/agent.ts`, `bindings.ts`, `bootstrap.ts`, `logger.ts`, `wire-log.ts` | Credo 0.7 agent factory, binding import order, ledger bootstrap with identifier derivation, working logger, wire-level message logger |
| `phase0/agent/src/s3-control.ts` | Credo ↔ Credo v1 round trip |
| `phase0/agent/src/s5-mediated.ts` | Round trip through the mediator (`PICKUP_STRATEGY` env selects the holder strategy) |
| `phase0/agent/src/s7-offline.ts` | Offline delivery with a Credo holder |
| `phase0/agent/src/s7-android-offline.ts` | Live + offline + proof against the Android app, driven over adb |
| `phase0/android/` | Kotlin framework with the §2.7.4 fork changes and the sample app repointed at the rig |

Rig-only notes (not design): the Android phone reached the host's native Node issuer through `adb reverse tcp:3001 tcp:3001`, because Windows Firewall blocks native processes on the LAN while Docker-published ports (ledger, mediator) are reachable directly.
