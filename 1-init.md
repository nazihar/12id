# SSI Platform — System Architecture and Implementation Plan

**Status:** Design handover document
**Audience:** Implementation engineer / coding agent
**Stack decision:** Credo-TS + DIDComm v1 + AnonCreds + Hyperledger Indy

---

## 0. How to use this document

Sections 1–6 describe *what* the system is. Sections 7–9 list *what to install*. Section 10 is the work breakdown — treat each item there as a ticket. Section 11 lists known traps. Section 12 lists decisions that are still open and must be resolved before certain phases can start.

Anywhere this document names a package version or exact package name, **verify it against the version of Credo you actually install** before writing code. This ecosystem renamed itself (Hyperledger Aries → OpenWallet Foundation Credo) and package scopes moved with it. The Credo docs at `https://credo.js.org` are authoritative.

### 0.1 Confidence levels — read this before treating anything here as fact

This document was assembled from project READMEs, documentation sites and specifications. **Nothing in it has been validated by running the stack.** Treat the contents in three tiers:

**Tier 1 — confirmed from primary sources.** Component responsibilities, the mediator's configuration surface and protocol list, the native frameworks' stated RFC support, Indy's architecture and consensus model, repository locations. Safe to build on.

**Tier 2 — reasoned inference, needs empirical confirmation.** The v1-vs-v2 protocol conclusion (§2.7.1), the identifier format concern (§2.7.2), the pickup strategy question (§2.7.3), and the mobile network reachability risk (§4.6). The reasoning is sound but the behaviour has not been observed. **Phase 0 exists to convert these to Tier 1.** Do not design around them as settled facts before then.

**Tier 3 — verify before use.** All exact package names and version numbers. Scopes moved during the Aries→Credo transition and version numbers quoted here came from documentation snapshots that may be stale. Resolve each against the live registry.

If an item in Tier 2 turns out differently than described, the affected configuration changes but the architecture does not. If several turn out differently, revisit §12.

### 0.2 Ledger object identifiers — note on why this document hedges

The same underlying object can be addressed two ways: legacy unqualified (`Th7MpTaRZVRYnPiabds81Y:2:schema:1.0`) or fully qualified (`did:indy:...`). Different-generation agents expect different forms, and a mismatch produces silent failures rather than errors. This is why §2.7.2 exists and why the tenant onboarding flow in §4.2 should not be implemented until Phase 0 answers it.

---

## 1. Scope and design decisions

### 1.1 What we are building

A multi-tenant self-sovereign identity platform. Our customers are organisations who want to issue and verify verifiable credentials. We provide:

- Hosted issuer and verifier agents, driven by a REST API
- A native mobile SDK (iOS and Android) our customers embed in **their own** apps to act as the credential holder
- The supporting infrastructure: DIDComm mediator, Indy ledger access, revocation tails hosting

### 1.2 Locked-in decisions

| Decision | Choice | Reason |
|---|---|---|
| Credential format | AnonCreds | Selective disclosure, predicate proofs, unlinkable presentations |
| Transport protocol | DIDComm v1 | Required by AnonCreds-over-DIDComm ecosystem; what the mediator and native frameworks support |
| Trust registry | Hyperledger Indy | Native home for AnonCreds objects; `did:indy` |
| Server framework | Credo-TS (Node.js) | Most mature, actively maintained, covers issuer + verifier + mediator |
| Holder implementation | Native (Swift + Kotlin) | We ship an SDK for embedding in customer apps; React Native is not viable as an embedded SDK |
| Key custody | On device | Holder keys and link secret never leave the user's phone |

### 1.3 Explicitly out of scope for v1

- DIDComm v2 (not supported by the mediator; roadmap item only)
- OpenID4VC / SD-JWT VC (may be added later — keep the issuance API abstracted so this stays possible)
- Cloud/custodial wallets
- W3C VC Data Model credentials

---

## 2. Component inventory

### 2.1 Indy ledger pool

**Purpose.** Public, append-only registry of DIDs, credential schemas, credential definitions, and revocation registry definitions. **No personal data or credentials ever go here.**

**Runtime.** `indy-node` validators. Byzantine fault tolerance follows `n = 3f + 1` — four nodes tolerate one faulty node, seven tolerate two.

**Environments.**
- Dev/CI: `von-network` — Docker Compose, 4 nodes, ledger browser UI, auto-generated genesis
- Production: `indy-node-container` images on dedicated hosts, or a permissioned network operated by a third party (e.g. Indicio)

**Requirements per validator.** Static public IP, two open TCP ports (node-to-node consensus, client-to-node), 8 GB RAM for private low-traffic networks.

**Roles.** Trustees govern the pool. Stewards operate validators. **Endorsers** write schemas and credential definitions — our issuer DID needs the `ENDORSER` role.

> See §12.1 — the node count decision is still open.

### 2.2 Tails server

**Purpose.** Serves revocation tails files over plain HTTP. Required only if credentials are revocable.

**Why separate.** Tails files can be large and are fetched by holders when constructing non-revocation proofs. They are not secret — they are public cryptographic material. Host behind a CDN.

**Runtime.** `bcgov/indy-tails-server` (verified: active project, container image published at `ghcr.io/bcgov/indy-tails-server/tails-server`), or any static file host with a stable URL. It exposes upload and download endpoints keyed by revocation registry ID, and newer endpoints keyed by **tails file hash** — the hash-based endpoints were added to support ledger-agnostic AnonCreds, and are the better choice if you ever move off Indy.

The URL is baked into the revocation registry definition on the ledger and **cannot be changed afterwards** for that registry.

### 2.3 Mediator

**Purpose.** Public DIDComm endpoint that receives messages on behalf of mobile wallets, queues them, and delivers them when the wallet connects. The wallet has no stable inbound address, so this is mandatory.

**Runtime.** `didcomm-mediator-credo`, deployed from the official Docker image:
```
ghcr.io/openwallet-foundation/didcomm-mediator-credo/mediator:latest
```

**Protocols implemented.** Out-of-band invitation (RFC 0434), mediator coordination (RFC 0211), pickup v1 (RFC 0212) and pickup v2 (RFC 0685). The mediator also supports implicit pickup — connect a WebSocket, send any DIDComm message to authenticate, and receive. Pickup v2 is the mediator's recommendation, **but the strategy we use is dictated by what the native holder frameworks support** (see §2.7.3).

**Open mediation — unresolved gap.** The mediator currently grants mediation to any agent that asks. Controlling acceptance of mediation requests is listed on the project roadmap and is **not implemented**. Without mitigation, anyone who obtains our mediator's invitation URL can register a wallet and use it as free message relay infrastructure.

Mitigations to implement ourselves:
- Do not publish a static, universally-shared invitation. Serve per-tenant or per-user invitations from the platform API behind auth, with short expiry.
- Rate limit mediation requests at the ingress layer.
- Monitor mediation record creation rate and alert on anomalies.
- Consider a reverse proxy that requires a signed token before reaching the mediator's endpoint.

**Key configuration.**

| Option | Our setting | Notes |
|---|---|---|
| `storage.type` | `drizzle` (postgres) | Or `askar`; run migrations before deploy |
| `cache.type` | `redis` | Required if running multiple instances |
| `messagePickup.storage.type` | `postgres` | Survives restarts |
| `messagePickup.forwardingStrategy` | `QueueAndLiveModeDelivery` | Deliver live if connected, queue otherwise |
| `messagePickup.multiInstanceDelivery.type` | `redis` | Uses Redis streams; requires `cache.type: redis` |
| `pushNotifications.webhookUrl` | our platform API | Fires when a message is queued but undeliverable |
| `agentEndpoints` | `https://…` and `wss://…` | Both HTTP and WebSocket must be publicly reachable |

Config is supplied via environment variables (nested keys use double underscores, e.g. `MESSAGE_PICKUP__STORAGE__TYPE`) or a JSON file pointed at by `CONFIG`.

**Recommended Node flags** (from the project README): `NODE_OPTIONS=--max-old-space-size=512`, `MALLOC_CONF=background_thread:true,metadata_thp:auto`, and `LD_PRELOAD` set to jemalloc.

**Critical property.** The mediator sees only encrypted envelopes. It cannot read credentials, proofs, or connection contents. It *does* see metadata: which wallet, how often, message sizes.

### 2.4 Issuer agent

**Purpose.** Holds the organisation's DID and signing keys. Publishes schemas and credential definitions. Runs the issue-credential protocol with holders. Manages revocation.

**Runtime.** Node.js service embedding a Credo agent, with an HTTP inbound transport on a public URL.

**Storage.** Askar wallet backed by Postgres.

**Multi-tenancy.** One agent process, one tenant per customer organisation, via `@credo-ts/tenants`. Each tenant gets its own encrypted storage partition. Do **not** run one process per customer.

### 2.5 Verifier agent

**Purpose.** Builds proof requests, runs present-proof with holders, verifies the resulting proofs against ledger state.

**Runtime.** Same shape as the issuer. It can be the *same process* with different modules enabled, but separate deployments are recommended so verification traffic cannot starve issuance.

**Note.** Verification is fully offline with respect to the issuer — the verifier never contacts the issuing organisation, only the ledger.

### 2.6 Platform API

**Purpose.** The product. Everything our customers actually touch.

Responsibilities:
- REST API over the issuer and verifier agents
- Tenant and API key management
- Schema and credential definition catalogue
- Proof request templates
- Webhook delivery to customer backends
- Admin UI
- Business-data-to-credential-attribute mapping

**Runtime.** Node.js/TypeScript. Own Postgres database, separate from the agent wallet storage.

### 2.7 Holder SDK

**Purpose.** Embedded in our customers' native apps. Holds the user's wallet, keys, link secret, and credentials on device.

**Runtime.**
- iOS: fork of `aries-framework-swift`, distributed via Swift Package Manager
- Android: fork of `aries-framework-kotlin`, republished to our own Maven repository

Both depend on `aries-uniffi-wrappers`, which provides Askar, AnonCreds, and Indy VDR as native bindings generated by UniFFI.

**Supported protocols** (per the Kotlin framework's stated feature set — verify parity on Swift):
- RFC 0160 Connection Protocol
- RFC 0023 DID Exchange
- RFC 0434 Out of Band
- RFC 0211 Mediator Coordination
- RFC 0036 Issue Credential **(v1)**
- RFC 0037 Present Proof **(v1)**
- RFC 0095 Basic Message
- HTTP and WebSocket transport

**This list defines the protocol ceiling for the entire platform.** Configure the issuer, verifier and mediator to stay inside it.

### 2.7.1 Critical: the holder speaks v1 issuance and presentation

RFC 0036 and RFC 0037 are the **version 1** issue-credential and present-proof protocols. The v2 protocols are RFC 0453 and RFC 0454, and the native frameworks do not implement them.

Consequence: **the issuer and verifier agents must register Credo's V1 credential and proof protocols**, not the v2 ones. In Credo these come from the AnonCreds module (`V1CredentialProtocol`, `V1ProofProtocol`) and must be explicitly registered on `CredentialsModule` and `ProofsModule`. Credo's defaults lean toward v2, so this is an active configuration choice, not something you get for free.

Registering both v1 and v2 is possible and is the safer option — it keeps the door open for a future Credo-based holder — but v1 must be present and must be what the native SDK negotiates.

### 2.7.2 Verify before Phase 1: identifier format

The native frameworks are AIP 1.0 era and are likely to expect **legacy unqualified AnonCreds identifiers** (e.g. `Th7MpTaRZVRYnPiabds81Y:2:schema:1.0`) rather than fully-qualified `did:indy` identifiers.

If our issuer publishes `did:indy` DIDs and qualified credential definition IDs, the holder may fail to resolve them. Determine empirically in Phase 0 which format each framework accepts, and configure the issuer to match. This affects §4.2 step 2 — we may need `did:sov` style unqualified DIDs instead of `did:indy`.

### 2.7.3 Verify before Phase 1: message pickup strategy

The Swift sample app configures `mediatorPickupStrategy: .Implicit`, which means "hold a WebSocket open and receive whatever arrives" rather than running pickup v2 (RFC 0685) explicitly. It is not confirmed that either native framework implements pickup v2.

This matters because the mediator's `messagePickup.forwardingStrategy` must match what the holder actually does:

- If the holder uses **implicit** pickup → mediator needs `DirectDelivery` or `QueueAndLiveModeDelivery`
- If the holder supports **pickup v2** → `QueueAndLiveModeDelivery` is correct and offline messages are retrievable on demand

Implicit-only pickup is weaker: messages queued while the app was closed may need the socket to be open before they flow, which interacts badly with the push-notification wake path in §4.8. Confirm this in Phase 0.

---

## 3. Communication matrix

| From | To | Protocol | Transport | Direction | Notes |
|---|---|---|---|---|---|
| Holder SDK | Mediator | DIDComm v1, pickup strategy TBD (§2.7.3) | WSS (primary), HTTPS | Outbound from device | Persistent WebSocket while app is foregrounded |
| Mediator | Holder SDK | DIDComm v1 | WSS | Over the open socket | Live delivery only; otherwise queued |
| Mediator | Platform API | HTTPS webhook | HTTPS | Outbound | Fires on undeliverable queued message; includes `connectionId` and FCM token if known |
| Platform API | FCM / APNs | Push | HTTPS | Outbound | Wakes the device to trigger pickup |
| Issuer agent | Mediator | DIDComm v1 forward | HTTPS | Outbound | Messages to holders are addressed to the mediator |
| Verifier agent | Mediator | DIDComm v1 forward | HTTPS | Outbound | Same |
| Mediator | Issuer/Verifier agent | DIDComm v1 | HTTPS | Inbound to agent | Agent endpoints must be publicly reachable |
| Issuer agent | Indy pool | Indy client protocol | TCP (client port) | Outbound | Writes: NYM, SCHEMA, CLAIM_DEF, REVOC_REG |
| Verifier agent | Indy pool | Indy client protocol | TCP | Outbound | Reads only |
| Holder SDK | Indy pool | Indy client protocol | TCP | Outbound from device | Reads schema, cred def, revocation state |
| Holder SDK | Tails server | HTTPS GET | HTTPS | Outbound | Fetches tails file for non-revocation proofs |
| Customer backend | Platform API | REST | HTTPS | Inbound | API key auth |
| Platform API | Customer backend | HTTPS webhook | HTTPS | Outbound | Signed payloads, with retry |

**Network exposure summary.**

Publicly reachable: mediator (HTTPS + WSS), issuer agent endpoint, verifier agent endpoint, tails server, platform API, Indy validator client ports.

Private: Postgres instances, Redis, admin UI (behind auth + IP allowlist).

---

## 4. Key flows

### 4.1 Ledger bootstrap (one time, per environment)

1. Stand up the Indy pool. Capture the genesis file.
2. Create a Trustee DID (network operator).
3. Create the platform's Endorser DID; Trustee writes the NYM with `ENDORSER` role.
4. Accept the Transaction Author Agreement if the network has one.
5. Publish the genesis file to a URL our agents and SDK can fetch.

### 4.2 Tenant onboarding (per customer organisation)

1. Platform API creates a Credo tenant.
2. Tenant agent creates a `did:indy` DID; the platform Endorser writes the NYM.
3. Customer defines a schema through the admin UI.
4. Issuer publishes SCHEMA, then CLAIM_DEF (with `supportRevocation` if needed).
5. If revocable: publish revocation registry definition + initial entry; upload tails file to tails server.
6. Persist all resulting identifiers in the platform database.

### 4.3 Wallet onboarding (per end user, first app launch)

1. SDK generates a wallet key, stores it in Keychain (iOS) / Keystore (Android).
2. SDK initialises the Askar wallet and opens the Indy pool using the genesis file.
3. SDK fetches the mediator's out-of-band invitation from the platform API.
4. SDK completes the DIDComm connection to the mediator.
5. SDK sends a mediation request; mediator grants and returns routing key + endpoint.
6. SDK opens a WebSocket and begins pickup v2.

From this point, every DID the wallet creates embeds the mediator's routing key and endpoint in its DID document.

### 4.4 Connection establishment (holder ↔ issuer)

1. Customer backend calls `POST /connections/invitation`; platform returns an OOB invitation URL and QR payload.
2. Holder scans/opens it; SDK runs DID exchange.
3. Both sides end up with a pairwise `did:peer`.
4. Platform API receives a Credo connection event, persists it, fires a webhook to the customer.

Connections are pairwise — the same user talking to two customers has two unrelated DIDs and cannot be correlated across them.

### 4.5 Credential issuance

1. Customer backend calls `POST /credentials/offer` with a connection ID, credential definition ID, and attribute values.
2. Platform maps the payload, calls Credo's issue-credential **v1** API (`V1CredentialProtocol`, AnonCreds format), returns a record ID **immediately**. See §2.7.1 — v1 is required because the native holder does not implement v2.
3. Offer travels: issuer → mediator → holder.
4. SDK surfaces the offer; user accepts.
5. SDK sends a credential request containing a blinded commitment to the user's link secret.
6. Issuer signs and issues; holder stores.
7. Credo emits state-change events at every step. The platform listener persists state and fires webhooks.

**Nothing about this transaction is written to the ledger.**

### 4.6 Presentation / verification

1. Customer backend calls `POST /proofs/request` with a template ID and connection ID.
2. Platform expands the template into a full proof request: requested attributes, predicates, restrictions on `cred_def_id` / `issuer_did`, and a non-revocation interval if applicable.
3. Request travels to the holder.
4. SDK finds matching credentials, presents the choice to the user.
5. SDK builds a zero-knowledge proof (fetching tails file if non-revocation is required).
6. Verifier resolves schema, credential definition, and revocation state from the ledger, and verifies.
7. Platform fires a webhook with the verification result and disclosed attributes.

> **Reachability risk.** Steps 5 and 6 require the *holder's phone* to reach the Indy validators' client port directly, and to fetch the tails file over HTTPS. The Indy client port is non-standard and is blocked on some corporate Wi-Fi and restrictive mobile networks. If Phase 0 testing shows this failing on real networks, investigate `indy-vdr-proxy` (ships with the indy-vdr project) which exposes ledger reads over HTTP on port 443. Note this would require the native frameworks to support an HTTP resolver rather than direct pool connection — verify feasibility before relying on it.

### 4.7 Revocation

1. Customer calls `POST /credentials/{id}/revoke`.
2. Issuer marks the credential index revoked and publishes a new revocation registry entry to the ledger.
3. Entries should be **batched** — publishing one ledger transaction per revocation does not scale.
4. When a registry fills, publish a new one and route subsequent issuance to it.

### 4.8 Offline / background message delivery

1. Mediator cannot deliver a queued message live.
2. Mediator POSTs to our webhook URL with `connectionId` and, if known, the device FCM token.
3. Platform API sends a push via FCM or APNs.
4. Customer app receives it, calls our SDK's `sync()` method.
5. SDK opens a WebSocket, runs pickup, processes the message.

> Design note: the SDK should expose `sync()` for the host app to call from its own notification handler, rather than claiming a notification category. Customers will already have push infrastructure.

---

## 5. Data and storage

| Store | Contents | Encryption |
|---|---|---|
| Agent Askar wallet (Postgres) | DIDs, keys, connections, credential records, protocol state | Askar encrypts at rest with the store key |
| Platform database (Postgres) | Tenants, API keys, schema catalogue, proof templates, webhook config, denormalised protocol state for querying | Standard DB encryption |
| Mediator database (Postgres) | Connections, mediation records, queued encrypted messages | Askar / Drizzle |
| Redis | Mediator cache, multi-instance delivery streams, platform job queue | — |
| Device (Askar/SQLite) | User's keys, link secret, credentials, connections | Askar, key in Keychain/Keystore |
| Indy ledger | DIDs, schemas, cred defs, revocation registries | Public, unencrypted, immutable |

**Never store on the ledger:** personal data, credential attribute values, connection records, presentation records, hashes of personal data.

### 5.1 Schema and credential definition immutability

Ledger objects cannot be modified or deleted. Consequences to design for:

- A schema's attribute list is fixed at publication. Adding a field means publishing a **new schema version** and a new credential definition. Build version handling into the catalogue from the start — customers *will* ask to add a field.
- Credentials already issued against the old credential definition remain valid. Proof request templates must be able to accept multiple credential definition IDs for the same logical credential type.
- Plan a deprecation flow: mark a schema version inactive for new issuance while keeping it accepted for verification.

### 5.2 Attribute encoding

AnonCreds attribute values are strings, with an integer encoding derived for the cryptographic layer. Credo handles the encoding, but the constraint is real: no nested objects, no arrays, no native numeric or date types. Dates go in as ISO strings or epoch integers-as-strings. Predicates (`>=`, `<`) only work on attributes whose values are integers.

Document this clearly for customers — it is the most common source of schema design mistakes.

### 5.3 Data protection posture

Because no personal data touches the ledger, the usual "blockchain vs right to erasure" conflict does not apply. The answer to a deletion request is: delete the holder's wallet data (on device, under the user's control), delete our platform records, and revoke the credential. The ledger retains only the revocation registry state, which is an anonymous index with no link to a person.

Write this up once as a customer-facing document — every enterprise customer's legal team will ask.

---

## 6. Security notes

- **Store keys** for Askar wallets go in a secrets manager, never in environment variables committed anywhere.
- **Endorser DID private key** is the highest-value secret in the system. Anyone with it can publish credential definitions under our name. Consider an HSM or at minimum a separate, tightly-scoped secrets store.
- **Wallet recovery** is not solved by default. If a user loses their phone, their link secret and credentials are gone. Decide explicitly: accept re-issuance as the recovery path, or build an encrypted backup/export flow. This is a product decision, not a technical one.
- **Mediator metadata** leaks traffic patterns per connection. Document this for customers.
- **Tails files are public.** Do not put them behind auth; do put them behind a CDN.
- **Genesis file integrity** matters — a malicious genesis file points a wallet at a fake ledger. Serve it over HTTPS with pinning, or sign it.

---

## 7. Packages — server side (Node.js)

### 7.1 Issuer and verifier agents

Core Credo packages:

```
@credo-ts/core
@credo-ts/node
@credo-ts/askar
@credo-ts/anoncreds
@credo-ts/indy-vdr
@credo-ts/tenants
```

These require native binding packages (Askar, AnonCreds, Indy VDR Rust libraries). **The scope for these moved from `@hyperledger/*` to the OpenWallet Foundation scope during the Aries→Credo transition — check the install guide at `https://credo.js.org` for the exact current names and versions matching your `@credo-ts/core` version.** Getting a mismatched binding version is the single most common setup failure.

Supporting libraries (our choices, not prescribed by Credo):

```
express            # or fastify / nestjs — HTTP server
tsoa               # optional: generates OpenAPI from controllers (credo-controller uses this)
zod                # request validation
drizzle-orm | prisma   # platform database
pg                 # postgres driver
bullmq + ioredis   # job queue for revocation batching, webhook retries
pino               # structured logging
@opentelemetry/*   # tracing
```

### 7.2 Reference implementations to read before writing code

| Project | Why |
|---|---|
| `openwallet-foundation/credo-ts` → `/demo` | The DIDComm + AnonCreds demo. Run it first. Fastest way to understand the API. |
| `@credo-ts/rest` (in `openwallet-foundation/credo-ts-ext`) | Official REST wrapper. **Appears stale** — last npm publish was some time ago and the Credo docs for it reference a much older core version. Read it for design reference; verify carefully before adopting as a dependency. |
| `credebl/credo-controller` | More actively maintained REST controller fork. Good reference for API design even if not adopted. |

**Read at least one of these end to end before designing our API.** They encode several weeks of design decisions.

### 7.3 Mediator

No code to write — deploy the image and configure it. Dependencies: Postgres, Redis.

Repository: `openwallet-foundation/didcomm-mediator-credo`

If using Drizzle storage, run migrations as a separate container from the same image before starting the mediator:

```
entrypoint: ["sh", "-c"]
command: pnpm --filter didcomm-mediator-service run drizzle:migrate:postgres
```

### 7.4 Ledger and tails

```
bcgov/von-network          # dev pool + ledger browser
hyperledger-indy/indy-node-container   # production validator images
hyperledger/indy-node-monitor          # validator-info collection, Grafana dashboards
bcgov/indy-tails-server                # tails file hosting
```

---

## 8. Packages — iOS SDK

```
LF-Decentralized-Trust-labs/aries-framework-swift   # fork this
LF-Decentralized-Trust-labs/aries-uniffi-wrappers   # AriesAskar, AnonCreds, IndyVdr
```

Swift Package Manager. Minimum iOS 15.0 (imposed by the WebSockets dependency).

Transitive dependencies pulled in by the framework: CollectionConcurrencyKit, BigInt, Base58Swift, Semaphore, Criollo (tests only).

**Bonus capability:** the Swift framework supports phone-to-phone DIDComm over Bluetooth (`ble://` endpoints), requiring `NSBluetoothAlwaysUsageDescription` in Info.plist. Not needed for v1 but worth knowing.

---

## 9. Packages — Android SDK

```
LF-Decentralized-Trust-labs/aries-framework-kotlin  # fork this
LF-Decentralized-Trust-labs/aries-uniffi-wrappers
```

Published to GitHub Packages as `org.hyperledger:aries-framework-kotlin`, with UniFFI wrappers as `org.hyperledger:anoncreds_uniffi`, `org.hyperledger:indy_vdr_uniffi`, `org.hyperledger:askar_uniffi`. Minimum Android 7.0.

> **Blocking issue:** GitHub Packages requires every consumer to configure a GitHub token with `read:packages`. We cannot ask our customers to do that. Since we are forking anyway, republish to Maven Central or our own repository under our own coordinates. Resolve this before the first customer integration.

---

## 10. Work breakdown

### Phase 0 — Spike (before committing to anything)

- [ ] Run the Credo `/demo` locally against `von-network`. Issue and verify one credential.
- [ ] Deploy the mediator locally with Docker Compose + ngrok.
- [ ] Build the `aries-framework-kotlin` sample app, point it at the local mediator and issuer, and complete a full issuance + verification round trip.
- [ ] Repeat with `aries-framework-swift`.

Record answers to each of these — they determine configuration across the whole platform:

- [ ] **Protocol versions.** Confirm the holder negotiates issue-credential v1 / present-proof v1. Confirm the issuer works with `V1CredentialProtocol` registered. (§2.7.1)
- [ ] **Identifier format.** Does the holder accept `did:indy` qualified schema and credential definition IDs, or does it require legacy unqualified IDs? (§2.7.2)
- [ ] **Pickup strategy.** Which pickup mode does each framework actually use — implicit WebSocket, pickup v1, or pickup v2? Match the mediator's `forwardingStrategy` to it. (§2.7.3)
- [ ] **Offline delivery.** Close the app, issue a credential, reopen. Does the queued message arrive? Test on both platforms.
- [ ] **Ledger reachability from mobile.** Test on cellular and on a restrictive corporate Wi-Fi. Does the Indy client port get through? (§4.6)
- [ ] **Revocation round trip.** Issue a revocable credential, revoke it, attempt a non-revocation proof. Confirm the holder can fetch the tails file and the verifier correctly rejects.
- [ ] **Feature parity.** Note every behaviour that differs between Swift and Kotlin. This becomes the SDK parity test suite.

- [ ] **Gate:** if the native frameworks cannot interoperate with our Credo issuer and mediator, the entire holder strategy needs rethinking. Do not proceed past this point until both platforms work.

### Phase 1 — Infrastructure

- [ ] Decide node count and operators (see §12.1)
- [ ] Stand up dev Indy pool (`von-network`)
- [ ] Stand up staging/production pool, or contract with a network operator
- [ ] Genesis file distribution endpoint (HTTPS, versioned, cacheable)
- [ ] Create Trustee and Endorser DIDs; document the TAA acceptance flow
- [ ] Deploy mediator: Postgres, Redis, Drizzle migrations, multi-instance Redis delivery
- [ ] Deploy tails server behind CDN
- [ ] `indy-node-monitor` + Grafana dashboards + alerting
- [ ] Secrets management for store keys and the Endorser key

### Phase 2 — Agent services

- [ ] Node service that boots a Credo agent with Askar/Postgres, AnonCreds, Indy VDR, tenants
- [ ] HTTP inbound + outbound transport, public endpoint, health checks
- [ ] Tenant provisioning: create tenant → create `did:indy` → endorse NYM
- [ ] Schema publishing
- [ ] Credential definition publishing (with and without revocation support)
- [ ] Revocation registry creation + tails upload
- [ ] Register **V1** credential and proof protocols on the agent (§2.7.1); pin the identifier format decided in Phase 0
- [ ] **Event listener** subscribing to all Credo state-change events, persisting to the platform DB
- [ ] Correlation IDs threaded through every protocol record so a single credential exchange can be traced across issuer, mediator and support tickets
- [ ] Schema versioning: publish new version, deprecate old, keep both verifiable (§5.1)
- [ ] Graceful shutdown (agent must close cleanly or the wallet can be left locked)
- [ ] Pin Credo versions identically across issuer, verifier and mediator; document the upgrade procedure (all three must move together)

### Phase 3 — Platform API

- [ ] Auth: API keys scoped per tenant
- [ ] `GET /mediator/invitation` — authenticated, short-lived, per-user mediator invitation (do not ship a static one; see §2.3)
- [ ] `GET /ledger/genesis` — versioned, cacheable genesis file endpoint for the SDK
- [ ] `POST /connections/invitation` — returns OOB URL + QR payload; support both single-use and multi-use invitations (kiosk and web-embed use cases need multi-use)
- [ ] `GET /connections`, `GET /connections/{id}`
- [ ] `POST /credentials/offer` — async, returns record ID
- [ ] `GET /credentials/{id}` — state polling
- [ ] `POST /credentials/{id}/revoke` — queued, batched
- [ ] Proof request template CRUD
- [ ] `POST /proofs/request` — async, returns record ID
- [ ] `GET /proofs/{id}` — result + disclosed attributes
- [ ] Webhook delivery: signed payloads, exponential backoff, dead-letter queue
- [ ] Mediator push webhook receiver → FCM/APNs dispatch
- [ ] OpenAPI spec published for customers

### Phase 4 — Admin UI

- [ ] Tenant management
- [ ] Schema and credential definition catalogue
- [ ] Proof template builder
- [ ] Credential and connection browser
- [ ] Revocation controls
- [ ] Webhook delivery log

### Phase 5 — Holder SDK

- [ ] Fork both frameworks; set up our own build and release pipeline
- [ ] **Resolve Android distribution** (republish to our own Maven repo)
- [ ] Design a single public API surface, identical on both platforms. Customers must never see Aries concepts. Target shape:
  - `initialize(config)`
  - `connect(invitationUrl)`
  - `credentials()` / `credential(id)`
  - `pendingOffers()` / `acceptOffer(id)` / `declineOffer(id)`
  - `pendingProofRequests()` / `respondToProofRequest(id, selection)` / `declineProofRequest(id)`
  - `sync()` — called by the host app from its push handler
  - delegate/listener for state changes
- [ ] Genesis file fetched from our server and cached, **not** compiled into the binary
- [ ] Mediator connection handled automatically on first init
- [ ] Wallet key generation and Keychain/Keystore storage
- [ ] Binary size reduction: ABI splits on Android, strip unused architectures
- [ ] Parity test suite running both SDKs against the same Credo issuer in CI
- [ ] Integration guide + sample app per platform

### Phase 6 — Hardening

- [ ] Load test the mediator (concurrent WebSocket connections is the limit that matters)
- [ ] Failover test: kill one Indy validator, confirm reads and writes continue
- [ ] Revocation at scale: batch publishing, registry rollover
- [ ] Key rotation runbook
- [ ] Disaster recovery: what happens if we lose the Endorser key, a wallet database, the mediator queue
- [ ] Document the wallet-recovery story for customers

---

## 11. Known traps

1. **Genesis file in the app binary.** If it is compiled in, changing validators means an app update for every customer's users. Fetch and cache it instead. This is the highest-impact item in this document.

2. **Native binding version mismatch.** `@credo-ts/*` packages must match their Askar/AnonCreds/Indy VDR binding versions exactly. Pin everything; do not use caret ranges.

3. **Treating issuance as synchronous.** DIDComm is asynchronous. The offer goes out, the response may arrive hours later. Build commands-in/events-out from day one or the architecture will fight you.

4. **Tails file URL is immutable.** It is written into the revocation registry definition on the ledger. Choose a stable URL — ideally your own domain in front of a CDN, never a bucket URL.

5. **Platform drift between iOS and Android SDKs.** Two independent codebases will diverge. Define one supported protocol matrix and test both against it in CI.

6. **Revocation registry capacity.** Registries have a fixed size. Plan rollover before you hit the limit in production.

7. **Non-revocation interval semantics.** Getting the `from`/`to` timestamps wrong in a proof request produces confusing verification failures. Test this deliberately.

8. **Mediator is a single point of failure** for every mobile user. Multi-instance with Redis streams from the start, not as an optimisation later.

9. **Askar wallet lock on unclean shutdown.** Agents must close gracefully. Add signal handlers.

10. **Labs-stage frameworks.** `aries-framework-swift` and `aries-framework-kotlin` are incubation projects with small maintainer bases. Budget for maintaining forks — this is not optional.

11. **Protocol version mismatch (v1 vs v2).** The highest-probability integration failure in this project. The native holders speak issue-credential v1 and present-proof v1; Credo leans toward v2. Symptom is a silent stall — the offer is sent, nothing comes back, no error. See §2.7.1.

12. **Qualified vs unqualified identifiers.** `did:indy` schema and credential definition IDs may not resolve on AIP 1.0 era holders. Same silent-failure symptom. See §2.7.2.

13. **Open mediation.** The mediator will relay for anyone who asks. We must build the access control ourselves. See §2.3.

14. **Schema is immutable.** A customer asking to "just add one field" means a new schema version, a new credential definition, and proof templates that accept both. Design for it on day one, not when the first request lands.

15. **Indy client port on mobile networks.** Non-standard port, blocked on some networks. Test early. See §4.6.

16. **Debugging across the mediator is hard.** A message that vanishes between issuer and holder has four possible resting places: issuer outbound queue, mediator queue, WebSocket, holder inbound processing. Without correlation IDs and logging at each hop, support will be guesswork.

17. **Multi-tenancy shares one endpoint.** All tenants' connections route through the same agent URL. Customers who want their own branded DIDComm endpoint cannot have one without a separate agent deployment. Set expectations in the sales conversation.

---

## 12. Open decisions

### 12.1 Indy node count and operators

If we run all validators ourselves, we have an append-only database with blockchain operating costs, not a decentralised ledger. Self-hosting only earns its keep when validators are operated by **different organisations**.

Options:
- **(a)** Run 4 nodes ourselves — simplest, honest about being centralised
- **(b)** Recruit customers or partners as stewards — real decentralisation, significant governance work
- **(c)** Use a third-party permissioned network — no ops burden, external dependency

**Must be decided before Phase 1.**

### 12.2 Wallet recovery

Accept loss and re-issue, or build encrypted backup? Affects SDK API surface. **Decide before Phase 5.**

### 12.3 Revocation in v1

Revocation adds the tails server, registry rollover, non-revocation intervals, and a meaningful amount of testing. Confirm whether v1 customers actually need it or whether short-lived credentials are sufficient. **Decide before Phase 2.**

### 12.4 Issuer/verifier deployment split

Same process with both module sets, or separate deployments? Separate is recommended but costs more. **Decide before Phase 2.**

### 12.5 Identifier format: did:indy or legacy

Determined empirically in Phase 0, but it is a decision with consequences. `did:indy` is the modern, specified form. Legacy unqualified identifiers are what AIP 1.0 tooling expects. If the native frameworks force us to legacy, note that this narrows future interoperability with newer agents. **Resolved by Phase 0 findings; document the choice explicitly.**

### 12.6 SDK development start date

Phase 5 is listed last, but the Phase 0 gate depends on the native frameworks working, and SDK work is the longest pole. Consider starting SDK work in parallel with Phase 2 rather than sequentially. **Decide during planning.**

### 12.7 Future OpenID4VC support

Not in v1 scope, but keep the issuance API abstracted at the platform layer so a second credential format can be added without rewriting customer-facing endpoints.

---

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
| Tails server | `bcgov/indy-tails-server` |
| Reference wallet (RN, for UX study) | `openwallet-foundation/bifold-wallet` |

## Appendix B — Documentation

- Credo docs: `https://credo.js.org`
- Credo mediation tutorial: `https://credo.js.org/guides/tutorials/mediation`
- Credo supported features: `https://credo.js.org/guides/features`
- AnonCreds specification: `https://hyperledger.github.io/anoncreds-spec/`
- Aries RFCs: `https://hyperledger.github.io/aries-rfcs/latest/`
- Interop test results: `https://aries-interop.info`