# Phase 0 — Findings

**Status:** Android gate items green (S1–S7, S9); S8 green on cellular and home Wi-Fi. Remaining: restrictive corporate Wi-Fi, and the Swift pass.
**Rig:** Windows 11, Docker Desktop, Node 22.20, von-network 4-node pool on `192.168.1.88`.
**Credo line under test:** 0.7.0.

Every claim below is backed by a run on this machine. Where something is still inferred
rather than observed it says so explicitly.

---

## Answered

### Q2 — Identifier format: **legacy unqualified is mandatory for v1** (Tier 1)

`init.md` §2.7.2 framed this as a native-framework quirk to check on Android. It is not.
It is enforced inside Credo itself, so it was answerable at S3 without a phone.

`LegacyIndyDidCommCredentialFormatService.processOffer`
(`node_modules/@credo-ts/anoncreds/build/formats/LegacyIndyDidCommCredentialFormatService.mjs:114`):

```js
if (!isUnqualifiedSchemaId(credOffer.schema_id) || !isUnqualifiedCredentialDefinitionId(credOffer.cred_def_id))
  throw new DidCommProblemReportError('Invalid credential offer', { problemCode: IssuanceAbandoned })
```

Observed: an issuer publishing `did:indy:von:<nym>/anoncreds/v0/CLAIM_DEF/58/default` and
offering it over v1 gets a `notification/1.0/problem-report` back with
`{"en":"Invalid credential offer","code":"issuance-abandoned"}`. The credential exchange
stalls at `offer-sent` with **no error on the issuer record** — exactly the silent stall
§11.11 and §11.12 predict.

**The awkward part:** `IndyVdrAnonCredsRegistry` *returns* did:indy-qualified identifiers
from `registerSchema` / `registerCredentialDefinition`, while writing the object to the
ledger unqualified. So the ID the registration API hands you is the one v1 refuses. Both
forms must be derived and stored, and the unqualified form used on the wire:

```
qualified   did:indy:von:JLNRNkS44QeUoJnwt4gKQh/anoncreds/v0/CLAIM_DEF/61/default
unqualified JLNRNkS44QeUoJnwt4gKQh:3:CL:61:default
```

Derive with `parseIndyCredentialDefinitionId` + `getUnqualifiedCredentialDefinitionId`
(both exported from `@credo-ts/anoncreds`); see `agent/src/bootstrap.ts`.

**Consequence for §12.5:** the decision is made for us as long as issue-credential v1 is
required, which it is as long as the holder is AIP 1.0. The platform database must store
both forms per ledger object and the API must be explicit about which one it hands out.

### Q8 — Credo line: **0.7.0 is viable** (Tier 1 for Credo-to-Credo; Tier 2 for the native holder)

0.7.0 still ships the v1 protocols and completes a full v1 round trip. No need to fall
back to 0.5.x on protocol-availability grounds. Whether the *native* holder interoperates
with 0.7 is still open until S6.

### Q1 — Protocol version: **the issuer can be pinned to v1** (Tier 1 for Credo; Tier 2 for the native holder)

With only the v1 protocols registered, a complete exchange runs at v1 end to end:
11 v1 protocol messages, 0 v2. Confirmed by `protocolVersion: 'v1'` on both the credential
and proof exchange records and by the message types on the wire.

**Still open:** whether the *native* holder negotiates the same. S6 answers that.

---

## Corrections to init.md (all verified against the installed packages)

1. **`@credo-ts/didcomm` is missing from the §7.1 package list.** 0.7 splits DIDComm out of
   core. Nothing works without it.
2. **The §2.7.1 class names are stale.** `V1CredentialProtocol` → `DidCommCredentialV1Protocol`,
   `V1ProofProtocol` → `DidCommProofV1Protocol`, `CredentialsModule` → `DidCommCredentialsModule`.
   All DIDComm exports carry the `DidComm` prefix, transports included
   (`DidCommHttpOutboundTransport`, `DidCommHttpInboundTransport`).
3. **Module registration is nested, not flat.** One `DidCommModule` takes `credentials`,
   `proofs`, `connections`, `mediationRecipient` etc. as nested config; the APIs live at
   `agent.modules.didcomm.credentials`, not `agent.modules.credentials`.
4. **Binding scopes are split**, contrary to the §7.1 implication that all moved:
   ```
   @credo-ts/{core,node,askar,anoncreds,indy-vdr,didcomm,tenants}  0.7.0
   @openwallet-foundation/askar-nodejs                             0.6.0   (moved to OWF)
   @hyperledger/anoncreds-nodejs                                   0.4.0   (still hyperledger)
   @hyperledger/indy-vdr-nodejs                                    0.3.0   (still hyperledger)
   ```
5. **§2.7.1's "Credo defaults lean toward v2" is confirmed verbatim in the source.**
   `DidCommCredentialsModuleConfigOptions`: *"When not provided, the `DidCommCredentialV2Protocol`
   is registered by default."*

---

## Traps hit while building the rig

Each of these cost real time and none are in §11. They belong in the Phase 2 runbook.

1. **Native binding import order is load-bearing.** `@openwallet-foundation/askar-shared`
   exports `askar` as `undefined` until the platform package registers it, and Credo's
   bundled build captures the binding at module-init time. Import a `@credo-ts/*` package
   before `askar-nodejs` and the agent dies at init with
   `Cannot read properties of undefined (reading 'keyGetJwkSecret')` — which reads exactly
   like the §11.2 version mismatch but is not one. Fix: `agent/src/bindings.ts`, imported first.
2. **`tsx` cannot run Credo 0.7.** It mis-resolves `webcrypto-core`'s dual CJS/ESM export,
   giving `Class extends value undefined`. Plain `node` with native TS support works.
   Use `node` or a `tsc` build; do not put `tsx` in the toolchain.
3. **von-network on Docker Desktop for Windows needs an explicit IP.** `./manage start`
   with no argument writes `host.docker.internal` into the pool config; the validators then
   cannot reach each other and `/genesis` serves 503 forever while the containers look
   healthy. `./manage start <LAN-IP>` fixes it, and the LAN IP is what a phone needs anyway.
4. **`receiveInvitationFromUrl(url, {})` breaks the handshake.** Passing an empty config
   overrides the agent label with `undefined`; the DID exchange request then fails class
   validation on send. Pass `{ label }` explicitly.
5. **Connection auto-accept is off by default** and is configured separately from credential
   and proof auto-accept (`connections: { autoAcceptConnections }`). Without it the responder
   parks at `request-received` with no error.
6. **Event names and payload keys changed.** `DidCommCredentialStateChanged` (not
   `CredentialStateChanged`), and the payload is `credentialExchangeRecord` (not
   `credentialRecord`). Proofs use `DidCommProofStateChanged` with `proofRecord`.

---

## Open / carried forward

- **Q1, Q3, Q4, Q5, Q6, Q7** — pending S4 onward.
- **`did:sov` message-type prefix (feeds Q1).** With `useDidSovPrefixWhereAllowed: true`,
  every logged message type still shows the `https://didcomm.org/...` form and zero
  `did:sov:...;spec/...`. **Caveat: the wire logger reads the message object, which may be
  pre-serialization**, so this is not yet proof of what goes out on the wire. Must be
  confirmed from raw HTTP bytes during S6 — an AIP 1.0 holder may require the did:sov form.
- **Revocation** is out of scope per the v1 decision; no tails server was deployed.

---

## Reproducing

```
cd phase0/von-network && ./manage start 192.168.1.88     # S1
cd phase0/agent && npm install
node src/s2-ledger.ts                                     # S2: endorser DID, schema, cred def
node src/s3-control.ts                                    # S3: full v1 round trip
```

`s3-control.ts` prints every DIDComm message type crossing the wire plus a v1/v2 tally.
That output is the evidence for Q1 and the diagnostic that localises any stall.

---

## S4 / S5 — Mediator (complete)

Both green. A Credo holder with **no inbound transport** registers for mediation, and the
full v1 issue + verify round trip completes with every message routed through the mediator:
`proof verified through mediator, isVerified: true`.

### Q3 — Pickup strategy: **`PickUpV2LiveMode` ↔ `QueueAndLiveModeDelivery` works** (Tier 1 for Credo, Tier 2 for the native holder)

Observed pickup traffic on the wire: `messagepickup/2.0/status`, `.../delivery`,
`.../messages-received`. The pairing in §2.7.3 is confirmed for a Credo holder. Whether
the native holder can do pickup v2 — or is implicit-only — is still open until S6. The
`PICKUP_STRATEGY` env var on `s5-mediated.ts` re-runs the same test against
`Implicit`, `PickUpV1` or `PickUpV2` so the mediator setting can be matched to whatever
S6 reveals without rewriting anything.

### Mediator deployment corrections to init.md

These are all in §2.3 / §7.3 and all block a first deployment.

1. **`mediator:latest` does not exist.** The image publishes **only commit-SHA tags**
   (`ghcr.io/.../mediator:375518d`). The §2.3 deploy line fails with `not found`.
   Pinning a SHA is what §11.2 wants anyway, but the documented command cannot work.
2. **The §7.3 migration command fails.** The repo root and `apps/mediator` **share the
   package name `didcomm-mediator-service`**, so `pnpm --filter didcomm-mediator-service …`
   is ambiguous and pnpm just prints its help text. Working form:
   ```
   cd /app/apps/mediator && pnpm run drizzle:migrate:postgres --database-url "$STORAGE__DATABASE_URL"
   ```
3. **The migration silently no-ops without `--database-url`.** It exits 0 with no output
   and creates nothing; the mediator then dies at startup with
   `relation "StorageVersion" does not exist`. A zero exit code from the migration step
   does not mean the schema exists — health-check the tables.
4. **`AGENT_PORT` is missing from the §2.3 config table and defaults to 3110.**
   `AGENT_ENDPOINTS` only sets what the mediator *advertises*. Set both or the mediator
   advertises `:3000` while listening on `:3110`, and every inbound connection fails with
   an empty reply while the container looks healthy.
5. **`MESSAGE_PICKUP__STORAGE__HOST` takes a bare hostname, no port** (there is no port
   key; 5432 is assumed). `ASKAR__DATABASE__HOST` *does* take `host:port`. Passing
   `postgres:5432` to the former fails with `getaddrinfo ENOTFOUND postgres:5432`.
6. **`.env.example` disagrees with the config schema** in places (it documents
   `STORAGE__DIALECT`; some error strings claim `DRIZZLE__DIALECT`). The Zod schema in
   `apps/mediator/src/config.ts` is the authority — read it, not the example file.
7. **pnpm is delivered by corepack and downloaded at run time**, so the migration
   container needs outbound npmjs access. Worth pre-baking for a locked-down environment.

### Correction to my own earlier note

The mediator image is on **Credo 0.6.0**, not 0.7 (`@credo-ts/drizzle-storage@0.6.0`,
`@openwallet-foundation/askar-nodejs@0.4.3`). It depends on `@credo-ts/didcomm`, which is
what I first inferred 0.7 from.

**This matters for §10 Phase 2's "pin Credo versions identically across issuer, verifier
and mediator".** That is **not currently satisfiable** with the published image: our agents
run 0.7.0 and the mediator runs 0.6.0. S5 shows the combination interoperates fine — DIDComm
is a wire protocol, not a linked library — so the guidance should be rewritten as
"pin each component explicitly and test the combination", not "keep the versions equal".

### Confirmations

- **Open mediation (§2.3) confirmed.** The mediator prints a reusable OOB invitation at
  startup and grants mediation to anyone presenting it. No authentication anywhere. The
  §2.3 mitigations are ours to build.
- The mediator's invitation advertises `handshake_protocols` of **both**
  `didexchange/1.1` and `connections/1.0`, and `accept: ["didcomm/aip1", "didcomm/aip2;env=rfc19"]`.
  RFC 0160 (`connections/1.0`) is what the Kotlin framework implements, so the mediator
  should be reachable by it. Encouraging for S6, but not yet evidence.

---

## Next

S6 (Android) is the remaining gate item and needs a device or emulator attached. S7/S8
follow from it. The rig is up and re-runnable; `s5-mediated.ts` is the exact scenario the
native holder has to reproduce.

---

## S9 — Fork feasibility probes (complete, source-level)

Done by reading `aries-framework-kotlin` at `phase0/android/`. These are Tier 1 for "what
the code does" and Tier 2 for "how it behaves on a device" until S6 runs.

### Q3 — Pickup strategy: **the Kotlin holder cannot do pickup v2** (Tier 1)

`AgentConfig.kt` defines exactly two strategies:

```kotlin
enum class MediatorPickupStrategy { PickUpV1, Implicit }
```

`MediationRecipient.pickupMessages()` implements only those two and throws on anything
else. There are **zero** references to RFC 0685 / `messagepickup/2.0` in the framework.
Implicit pickup is a `TrustPingMessage("pickup", responseRequested = false)` sent over
`ws`. Default is `PickUpV1`; the sample app overrides to `Implicit`.

**Consequence:** S5 passed using `PickUpV2LiveMode`, which the native holder can never use.
The mediator must be matched to `PickUpV1` (RFC 0212, which §2.3 says the mediator
implements) or `Implicit`. §2.7.3's question is closed on the holder side; which mediator
`forwardingStrategy` pairs with RFC 0212 batch-pickup still needs S6 to confirm.

### Q7 — Genesis at runtime: **no fork change needed** (Tier 1)

`AgentConfig.genesisPath` is a plain filesystem path and `LedgerService.openPool()` reads
it. The `assets.open()` copy is in the **sample app**, not the framework. Fetching genesis
from our server and caching it to a file is a normal use of the existing API.

**Trap §11.1 — described as "the highest-impact item in this document" — is not a framework
limitation at all.** It is purely an SDK-design choice we control. Cost: near zero.

### Q6 — Push token: **no push support in the framework** (Tier 1)

No FCM messaging, no device-token handling, no RFC 0699. The only Firebase references are
ML Vision barcode scanning in the sample app. Confirms the §4.8 gap.

**Recommended resolution, no fork work required:** do not try to get the token to the
mediator over DIDComm. Have the SDK register `deviceToken` with the Platform API at wallet
onboarding, and let the Platform API map `connectionId → token` when the mediator's webhook
fires. The webhook already carries `connectionId`. §4.8 should be rewritten accordingly and
the "FCM token if known" field treated as permanently absent.

### Q1 — did:sov message prefix: **the two sides already line up** (Tier 1 from source, pending S6)

This was flagged as an open caveat above; it now resolves, and the resolution matters
because a mismatch here is a silent stall.

- The Kotlin framework defaults `useLegacyDidSovPrefix = true` and **registers its message
  handlers under the did:sov form**: `handlers[replaceNewDidCommPrefixWithLegacyDidSov(...)]`.
  A message arriving as `https://didcomm.org/...` deserializes (both forms are registered
  as serializers) but would find **no handler** — the exact §11.11 symptom.
- Credo applies its rewrite at pack time in `DidCommEnvelopeService`
  (`payload.toJSON({ useDidSovPrefixWhereAllowed })`), and **every v1 credential and proof
  message class sets `allowDidSovPrefix = true`**.

So my earlier caveat was right: the wire logger reads the pre-serialization object, which
is why it showed 0 did:sov types. The packed envelope does carry the did:sov form, provided
`useDidSovPrefixWhereAllowed: true` is set — it defaults to **false** in Credo, so this is
a third mandatory configuration switch alongside protocol version and identifier format.
`agent/src/agent.ts` defaults it to true.

**Three settings must all be right or the native holder stalls silently:**

| Setting | Required value | Where |
|---|---|---|
| Credential/proof protocol | v1 registered explicitly | `DidCommCredentialV1Protocol`, `DidCommProofV1Protocol` |
| AnonCreds identifiers | legacy unqualified | offer/proof-request payloads |
| Message type prefix | `useDidSovPrefixWhereAllowed: true` | `DidCommModule` config |

---

## Gate status

| Step | Status |
|---|---|
| S1 ledger | green |
| S2 issuer + ledger objects | green |
| S3 Credo-to-Credo control | green, v1 end to end |
| S4 mediator | green |
| S5 mediated round trip | green, `isVerified: true` |
| S6 Android | **blocked on a device/emulator** |
| S7 offline delivery | follows S6 |
| S8 mobile ledger reachability | follows S6 |
| S9 fork probes | green (Q3, Q6, Q7 answered) |

Answered: **Q2, Q3, Q6, Q7, Q8**, and Q1 at source level on both sides.
Outstanding: **Q1 confirmed on device, Q4, Q5**, and the whole Swift pass.

Nothing found so far argues against the architecture. The three-setting alignment above is
the entire risk surface for §11.11 / §11.12, and all three are now known and configured.

---

## S6 — Native Android holder (in progress, device disconnected mid-run)

Device: Xiaomi 2109119DI, Android 14, arm64-v8a. The framework builds from source in the
sample app, so no GitHub Packages token was needed for this step (§9's blocker applies to
*consumers* of the published artifact, not to a source build).

### Reached so far

Connection to the issuer **completes** and the v1 offer goes out:

```
D/phase0  genesis fetched from http://192.168.1.88:9000/genesis (3091 bytes)
D/phase0  agent initialized
D/phase0  fetched issuer invitation (625 chars)
D/phase0  connected to issuer:  state=Complete
```

Issuer-side wire log: `connections/1.0/request` → `connections/1.0/response` →
`trust_ping/1.0/ping` → `issue-credential/1.0/offer-credential`.

### Q7 — confirmed on device (Tier 1)

Runtime genesis fetch works: the app pulls 3091 bytes over HTTP and writes it to
`filesDir`, and `LedgerService` opens the pool from that path. **Trap §11.1 is closed** —
no framework change needed, and no genesis in the binary.

### Q3 — implicit pickup confirmed working (Tier 1)

The holder holds a WebSocket open and sends `trust_ping` with `response_requested: false`
every 10 seconds. The mediator receives them continuously. This is the framework's
`Implicit` strategy exactly as described in §2.7.3.

### Two fork changes are mandatory before the holder can connect at all

Both were discovered by hitting them; both are one-liners; both are already applied in
`phase0/android/`.

**1. `OutOfBandInvitation.label` must be optional.**
`label` is declared as a required constructor parameter, but RFC 0434 makes it OPTIONAL
and `didcomm-mediator-credo` does not emit it. Result:

```
MissingFieldException: Field 'label' is required for type
  org.hyperledger.ariesframework.oob.messages.OutOfBandInvitation
  at OutOfBandInvitation.fromUrl → InvitationUrlParser.parseUrl → MediationRecipient.initialize
```

The stock framework **cannot parse the stock mediator's invitation**. Mediation is
impossible without this change.

**2. `DidDoc.@context` must be the modern URI — but only because the mediator image is Credo 0.6.**
The framework sends `https://w3id.org/did/v1`. The mediator rejected it:

```
property connection.didDoc.context has failed the following constraints:
  context must be equal to https://www.w3.org/ns/did/v1
```

Verified in both codebases:
- Credo **0.6.0** (`@credo-ts/didcomm@0.6.0` inside the image): `Equals("https://www.w3.org/ns/did/v1")`
- Credo **0.7.0**: `IsIn([DID_V1_CONTEXT_URL, "https://w3id.org/did/v1"])`

**So this AIP 1.0 incompatibility is already fixed upstream in 0.7 and only bites because
the published mediator image is 0.6.** Preferred fix is a 0.7 mediator (built from source
until a newer image is published), which makes this fork change unnecessary. Keeping the
fork change is harmless since we control both ends.

### `AGENT_ENDPOINTS` order is load-bearing for implicit pickup (Tier 1)

With `http,ws` the mediation grant fails:

```
Received 'coordinate-mediation/1.0/mediate-request'
Sending an outbound message via session failed with error: WebSocket transport session has been closed.
→ holder: "Mediation request timed out."
```

The holder does the handshake over the first advertised service (http) and pickup over the
socket, so the mediator's grant targets a session that isn't the one it has. Listing
**`ws://` first** fixes it and mediation completes. Note the mediator **refuses to start
with a ws-only `AGENT_ENDPOINTS`** ("Agent endpoints must contain at least one http:// or
https:// url"), so the order is the only lever.

This is a concrete answer to §2.7.3 that the document could not have predicted: it is not
just "match the forwarding strategy", it is also "advertise ws first".

### Open blocker at the point the device disconnected

The credential offer never reaches the mediator. The holder's DID document is correct:

```json
{ "serviceEndpoint": "ws://192.168.1.88:3000",
  "routingKeys": ["5tBdciLqyGhV1SJmwZtbkRbo1K8CQify9pQ5xRPhq2rW"], "type": "IndyAgent" }
```

The issuer's exchange sits at `offer-sent` with **no error on the record**, and the
mediator logs show no forward arriving — only the holder's pings. A direct WebSocket from
the host to `ws://192.168.1.88:3000` opens fine, so the endpoint is reachable; the issuer
simply never opens one. Next step is the debug-logged run that was interrupted.

Hypothesis to test first: Credo's outbound transport selection for an `IndyAgent`-type
service with a `ws://` endpoint plus routing keys. S5 never exercised this path because the
mediator advertised http first there.

### Rig / tooling notes worth keeping

- **Windows Firewall vs Docker.** Docker-published ports (ledger 9000, mediator 3000) are
  reachable from the LAN without any firewall rule — Docker Desktop opens them. A **native
  Node process is not**, so the issuer on 3001 was unreachable from the phone. Worked
  around with `adb reverse tcp:3001 tcp:3001` and an issuer endpoint of `127.0.0.1:3001`,
  which needs no elevation. (An earlier reading of "genesis=200 from the device" as proof
  the firewall rule had been applied was wrong — that port was open because of Docker.)
- **MIUI blocks adb installs**: `INSTALL_FAILED_VERIFICATION_FAILURE`, cleared with
  `adb shell settings put global verifier_verify_adb_installs 0`.
- **Credo's `ConsoleLogger` emitted nothing** in this build at any level. Replaced with
  `agent/src/logger.ts`. Worth knowing before Phase 2 — the default logger being silent is
  precisely what makes §11.16 (debugging across the mediator) painful.
- **Node strip-only TS mode** rejects constructor parameter properties. Relevant if Phase 2
  runs TypeScript without a compile step.

### Binary size — a hard number for Phase 5 (§10)

| Build | Size |
|---|---|
| Default (7 ABIs: arm64-v8a, armeabi, armeabi-v7a, mips, mips64, x86, x86_64) | **165.8 MB** |
| `splits { abi { include "arm64-v8a" } }` | **51.7 MB** |

**`ndk { abiFilters }` has no effect** — the UniFFI native libraries arrive via AARs, so
ABI *splits* are required, not filters. Worth writing into the Phase 5 ticket directly.

---

## Q3 / Q4 resolved locally — and they conflict

After the device dropped off USB, the remaining blocker was reproduced **without** it by
pointing the S5 Credo holder at the now-ws-first mediator. That turned out to be the same
failure the Android holder hit, so it was diagnosable locally.

### The blocker: `QueueAndLiveModeDelivery` never delivers to an implicit-pickup holder

The forward *does* reach the mediator — the earlier reading that the issuer never sent it
was wrong; the issuer connects, sends and immediately closes the socket
(`DidCommWsOutboundTransport.mjs:62` closes a new socket when no response is requested),
and the message arrives fine. The mediator then does this:

```
Received message with type 'did:sov:...;spec/routing/1.0/forward'
Queuing message...
[findLiveSessionInDb] record found status false
[emitMessageQueuedEvent] Emitting MessageQueuedEvent
```

**"Live mode" is a pickup-v2 concept.** An implicit-pickup holder never enters it, so the
message is queued for a live session that will never exist — while the holder is sitting
right there pinging every 10 seconds. Nothing errors anywhere. This is the §11.11 silent
stall in its purest form.

Switching the mediator to **`DirectDelivery`** fixes it immediately:

```
pickup strategy under test: Implicit
proof verified through mediator, isVerified: true
v1 protocol messages: 11 / v2 protocol messages: 0
```

**Correction to §2.7.3.** The document says implicit pickup needs "`DirectDelivery` **or**
`QueueAndLiveModeDelivery`". Empirically it is `DirectDelivery` **only** — the other value
silently drops every message.

### Q4 — offline delivery: **the message is lost** (Tier 1)

`DirectDelivery` does not queue, so this was the obvious next question. `s7-offline.ts`
shuts the holder agent down, issues a credential, and reopens it against the same Askar
store:

```
>>> holder SHUT DOWN (app closed)
offer sent while holder was offline
>>> reopening holder (app reopened)
=== Q4 RESULT ===
MESSAGE LOST - not delivered after reopen
holder credential records: []
```

Not delayed — **gone**, with no record created at all.

### The conflict this creates for §4.8

| Holder strategy | Mediator strategy | Live delivery | Offline delivery |
|---|---|---|---|
| Implicit | `QueueAndLiveModeDelivery` | **never delivers** | — |
| Implicit | `DirectDelivery` | works | **message lost** |
| PickUpV1 | `QueueAndLiveModeDelivery` | not yet testable | not yet testable |

The native holder can only do `Implicit` or `PickUpV1` (no pickup v2, confirmed in source).
Neither implicit combination gives offline delivery. **So the entire §4.8 push-notification
wake path — mediator webhook → FCM → `sync()` → collect queued messages — has nothing to
collect unless `PickUpV1` works.**

`PickUpV1` could not be tested with the Credo holder: with ws-first endpoints its mediation
grant times out (`MediationRecipientApi.requestAndAwaitGrant`), because Credo's PickUpV1
does not hold a socket open. The Kotlin framework is different — its `WsOutboundTransport`
keeps a single socket regardless of strategy — so **this specific combination has to be
tested on the device**, and it is now the most important open question in Phase 0.

If `PickUpV1` also fails to retrieve queued messages, the options narrow to: put a
DIDComm-v2-capable or pickup-v2-capable holder in the fork (significant work), or accept
that credentials can only be delivered while the wallet is open (a product constraint that
would need to go in front of customers).

### Q1 — did:sov wire prefix now confirmed empirically (Tier 1)

The earlier caveat is closed. The mediator logged an inbound message from our issuer as:

```
Received message with type 'did:sov:BzCbsNYhMrjHiqZDTUASHg;spec/routing/1.0/forward'
```

So `useDidSovPrefixWhereAllowed: true` really does rewrite the `@type` on the wire, and the
wire logger's `https://didcomm.org/...` readings were pre-serialization as suspected. The
setting is confirmed necessary and working.

### Minor observation

After a successful proof, the issuer failed to send the final `present-proof/1.0/ack`
("unable to resolve did"). The proof record still reached `state: done` and
`isVerified: true`, so verification is unaffected, but it should be understood before
Phase 2 builds webhook semantics on protocol completion.

### Mediator state left for the next device run

`MESSAGE_PICKUP__FORWARDING_STRATEGY: QueueAndLiveModeDelivery` (needed so messages queue
for the `PickUpV1` test). For the live-delivery path, switch to `DirectDelivery` and set
`PHASE0_PICKUP_STRATEGY = Implicit` in the app.

---

## S7 on the native holder — the §4.8 conflict is resolved (Tier 1)

**This section supersedes "Q3 / Q4 resolved locally — and they conflict" above.** The
untested row in that table was the one that mattered, and it works.

Configuration: Kotlin holder `MediatorPickupStrategy.PickUpV1` (RFC 0212 batch pickup,
polling every 10 s), mediator `QueueAndLiveModeDelivery`, mediator endpoints ws-first.
Script: `agent/src/s7-android-offline.ts`, which drives the phone over adb.

```
=== LIVE: offer while app is running ===
  04:13:22.417Z credential 1c3925a8 -> request-received
  04:13:22.703Z credential 1c3925a8 -> done
=== OFFLINE: force-stop app, offer, reopen ===
  04:13:22.900Z app force-stopped
  04:13:23.002Z offer sent while app closed
  04:13:38.124Z app reopened
  04:13:39.841Z credential d7cfebd2 -> request-received
  04:13:40.145Z credential d7cfebd2 -> done
=== S7 RESULTS (native holder) ===
live credential   : DONE
offline credential: DONE
proof             : DONE isVerified=true
```

The credential offered while the app was **force-stopped** was queued by the mediator and
collected **1.7 s after the app reopened** — app init plus the first batch pickup. That is
exactly what the §4.8 wake path needs: push → host app starts → SDK's first pickup
drains the queue.

### Final answer to Q3 and Q4

| Holder | Mediator | Live | Offline | Verdict |
|---|---|---|---|---|
| Implicit | `QueueAndLiveModeDelivery` | never delivers | — | broken, silently |
| Implicit | `DirectDelivery` | works | **lost** | unusable for §4.8 |
| **PickUpV1** | **`QueueAndLiveModeDelivery`** | **works** | **works** | **pin this** |

**Pinned configuration for Phase 1/2:**

- Holder SDK: `PickUpV1`. Do not ship the sample app's `Implicit` default.
- Mediator: `MESSAGE_PICKUP__FORWARDING_STRATEGY=QueueAndLiveModeDelivery`,
  `AGENT_ENDPOINTS` with `ws://` **first**.
- §2.7.3 should be rewritten around this table; its implicit-pickup guidance is wrong in both
  directions.

**Load note for Phase 6:** `PickUpV1` means every open wallet polls the mediator every
10 seconds (`AgentConfig.mediatorPollingInterval`). That — not idle WebSocket count — is
likely the load profile to test.

### Correction: the trailing `present-proof/1.0/ack` error is a test-harness artefact

Earlier this was logged as a possible protocol issue. The full error from this run is:

```
Error resolving did 'did:peer:1zQm…': AskarError: Error executing query. Invalid resource handle
```

`Invalid resource handle` means the Askar store had already been closed: the script calls
`issuer.shutdown()` while the holder's final ack is still being processed. In every run the
proof reached `done` with `isVerified: true` first. Most likely a shutdown race in the test
scripts rather than anything Phase 2 needs to design around. (Not separately confirmed by
delaying shutdown.)

---

## S8 — mobile ledger reachability (baseline only)

Probed the public BCovrin Test network's validator client ports (non-standard ports
9702–9708 on two hosts, from its published genesis) with a TCP connect, from the phone over
the home Wi-Fi and from the host as a control:

| Endpoint | Phone (Wi-Fi) | Host (control) |
|---|---|---|
| 130.107.207.129:9702–9708 | OPEN | OPEN |
| 138.197.138.255:9702–9708 | BLOCKED | BLOCKED |

Results are **identical** on both, so the one unreachable host is down on BCovrin's side;
this Wi-Fi does not filter Indy ports. **This is only the baseline.** Q5 is specifically about
cellular and restrictive corporate Wi-Fi, which need the phone moved onto those networks.
The probe is a one-line `toybox nc` loop over adb and does not need the rig.

---

## Updated gate status

| Step | Status |
|---|---|
| S1–S5 | green |
| S6 Android connect + issue + verify | **green** (with two fork changes and the pinned config) |
| S7 offline delivery | **green** — `PickUpV1` + `QueueAndLiveModeDelivery` |
| S8 mobile ledger reachability | cellular + home Wi-Fi OPEN (TCP); restrictive corporate Wi-Fi outstanding |
| S9 fork probes | green |
| Swift pass | not started (needs a Mac) |

Per the gate criteria: S3, S5 and S6 are green; Q1, Q2, Q3 are answered with evidence; Q4 is
answered yes; Q6 and Q7 have no blocking answer. **That is a conditional pass on Android.**
Phase 1 infrastructure may start. Phase 5 SDK work stays gated on the Swift pass, and Q5
should be closed before the ledger topology in §12.1 is committed.

---

## S8 — cellular result (Tier 1 for this carrier)

Phone on mobile data only: no `wlan0` address, default route via `rmnet_data1`
(`10.70.101.238/30`, carrier NAT). Carrier: **Grameenphone,** (LTE,Unknown).

| Endpoint | Cellular | Wi-Fi | Host |
|---|---|---|---|
| 130.107.207.129:9702–9708 (Indy client) | **OPEN** | OPEN | OPEN |
| 138.197.138.255:9702–9708 (Indy client) | BLOCKED | BLOCKED | BLOCKED |
| 130.107.207.129:443 / 138.197.138.255:443 | OPEN / OPEN | — | — |
| 1.1.1.1:443 | OPEN | — | — |
| `https://test.bcovrin.vonx.io/genesis` | 200 | — | — |

**Q5 on cellular: the non-standard Indy client ports are not filtered by this carrier.** The
443 control rules out "no connectivity" as an explanation. The second BCovrin host answers on
443 but refuses its Indy ports from every network, so that failure is on the ledger operator's side.

Limits of this evidence:
- **TCP connect only**, not a full ledger read by the framework. Given the ports open, an
  indy-vdr read should work, but that was not run over cellular.
- **One carrier.** Carrier-grade filtering varies; one operator passing does not cover others.
- **Restrictive corporate Wi-Fi is still untested.** That is the network type §4.6 is most worried about.

So Q5 moves from "unknown" to "fine on consumer networks tested so far". The `indy-vdr-proxy`
fallback in §4.6 is still worth keeping on the Phase 1 list until a corporate network has
been tried.
