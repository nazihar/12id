# Phase 0 — Interop Spike

## Context

[12id/init.md](12id/init.md) specifies a multi-tenant SSI platform (Credo-TS issuer/verifier + DIDComm mediator + Indy ledger + native holder SDK). The document is explicit that **nothing in it has been validated by running the stack** (§0.1), and that a cluster of unverified assumptions — protocol version, identifier format, pickup strategy, mobile ledger reachability — all fail *silently* if wrong (§11.11, §11.12). Phase 0 exists to convert those assumptions to fact, and it is a hard gate: if the native holder frameworks cannot interoperate with a Credo issuer and mediator, the holder strategy collapses and the architecture must be reconsidered.

The repository is empty apart from the design document. This plan builds the spike rig from scratch and drives it to a documented go/no-go.

**Outcome:** a `findings.md` answering every open question with observed evidence, plus a gate decision. No platform code is written in Phase 0 and nothing built here is production scaffolding.

### Decisions taken (this session)

| Decision | Choice | Consequence |
|---|---|---|
| iOS | **Android first, Swift second pass** | All questions answered on Android + server here. Swift verification is a separate pass on a Mac and **must complete before the gate is declared passed** — §11.5 (platform drift) is unmanaged until it does. |
| Revocation | **Not in v1** — resolves §12.3 | Drops the tails server, registry rollover and non-revocation intervals from Phase 0 *and* Phase 1. Removes traps §11.4, §11.6, §11.7. Credentials are short-lived. |
| Execution | **I drive everything runnable** | I build and run pool, mediator and agents on this machine and script the Android build; you attach a device and report what you observe. |

> **Flag on the revocation decision:** a credential definition published without `supportRevocation` cannot be retrofitted. Adding revocation later means new credential definitions and re-issuing every existing credential. The decision is reversible, but not cheaply. Worth confirming this is a product position and not just a Phase 0 scope cut.

---

## Verified facts that change the document

I checked the live registry and the upstream repos before planning. Four things in the document are stale — all Tier 3 items it told us to verify, plus one architectural change it doesn't know about.

**1. DIDComm moved out of core.** Credo 0.7.0 splits DIDComm into `@credo-ts/didcomm`. The §7.1 package list omits it. Nothing works without it.

**2. The v1 protocol class names in §2.7.1 no longer exist.** They were renamed in the refactor. The protocols themselves are still shipped, which is the load-bearing fact:

| §2.7.1 says | Actually (0.7.0) |
|---|---|
| `V1CredentialProtocol` | `DidCommCredentialV1Protocol` |
| `V1ProofProtocol` | `DidCommProofV1Protocol` |
| `CredentialsModule` / `ProofsModule` | `DidCommCredentialsModule` / `DidCommProofsModule` |
| — | `LegacyIndy*` credential/proof formats retained |

**3. Only *some* bindings moved to the OpenWallet Foundation scope.** §7.1 implies all did. Verified matrix for Credo 0.7.0 — pin exactly, no caret ranges (§11.2):

```
@credo-ts/{core,node,askar,anoncreds,indy-vdr,tenants,didcomm}  0.7.0
@openwallet-foundation/askar-nodejs                             0.6.0   (moved)
@hyperledger/anoncreds-nodejs                                   0.4.0   (still hyperledger)
@hyperledger/indy-vdr-nodejs                                    0.3.0   (still hyperledger)
```

**4. The mediator is already on the 0.7 line** — `apps/mediator/package.json` depends on `@credo-ts/didcomm`, which only exists from 0.6+. Given §2's rule that issuer, verifier and mediator move together, this settles the version question: **build the spike on 0.7.0**, which provably still ships the v1 protocols and legacy Indy identifier formats. Fallback to the 0.5 line (currently 0.5.19) only if v1 interop with the Kotlin holder fails on 0.7.x.

**5. A hole in the §4.8 push path.** The mediator ships `@credo-ts/didcomm-push-notifications` — that protocol is how it learns a device's FCM token. The Kotlin framework's README lists no push-notification protocol support and no device-token registration. So the mediator will likely *never* know the token, and the "FCM token if known" in §4.8 will always be unknown. Cheapest fix is probably to bypass the DIDComm protocol entirely: have the customer app hand the token to the Platform API, which maps `connectionId → token` itself. Phase 0 should confirm the gap rather than assume it.

---

## Questions Phase 0 must answer

Revised from the §10 checklist: revocation dropped, three questions added from the findings above.

| # | Question | Ref |
|---|---|---|
| Q1 | Does the holder negotiate issue-credential v1 / present-proof v1 against an issuer with `DidCommCredentialV1Protocol` registered? | §2.7.1 |
| Q2 | Does the holder accept `did:indy` qualified schema/cred-def IDs, or does it require legacy unqualified? | §2.7.2 |
| Q3 | Which pickup mode does the framework actually use — implicit WebSocket, pickup v1, or pickup v2? | §2.7.3 |
| Q4 | Close the app, issue a credential, reopen. Does the queued message arrive? | §4.8 |
| Q5 | Can the phone reach the Indy client port on cellular and on restrictive Wi-Fi? | §4.6 |
| Q6 | **New.** How does the FCM token reach the push path, given no RFC 0699 in the holder? | §4.8 |
| Q7 | **New.** Can the fork fetch the genesis file at runtime instead of loading it from app assets? | §11.1 |
| Q8 | **New.** Does the 0.7 line interoperate with the AIP 1.0 holder, or must we pin 0.5.x? | §7.1 |
| Q9 | Swift/Kotlin behavioural differences → seeds the parity suite. **(Deferred to the Swift pass.)** | §11.5 |

---

## The rig

Everything under `E:\12id-credo\phase0\`, disposable:

```
phase0/
  von-network/          cloned; 4-node pool + ledger browser + genesis at :9000
  mediator/             docker-compose: ghcr mediator image + postgres + redis
  agent/                Node/TS: issuer+verifier+Credo-holder in one process, HTTP triggers
  android/              cloned aries-framework-kotlin, sample app repointed
  findings.md           the deliverable
```

**Prerequisites you need to provide:** Docker Desktop started (installed, daemon currently stopped); an Android device or emulator with `adb` reachable (`adb` is present); Android Studio or a Gradle wrapper for the sample build (no standalone `gradle` on PATH — the repo wrapper covers it).

**Networking.** Emulator reaches the host at `10.0.2.2`; a physical device uses the LAN IP. `ngrok` is not installed — I'll use a `cloudflared` quick tunnel (no account needed, supports WSS) where a public HTTPS/WSS endpoint is required. For **Q5 specifically**, a local pool is useless because the phone must reach validator client ports over the internet: test that question against a public test network (BCovrin Test / Indicio TestNet), not von-network.

---

## Steps

Ordered so that a failure localises to one component. Each has an acceptance criterion — a step is not done until it is met.

**S1 — Ledger.** Clone and start von-network. → *Accept:* ledger browser reachable, genesis fetchable over HTTP, 4 nodes reporting.

**S2 — Issuer/verifier agent.** Node/TS project on the pinned 0.7.0 matrix. Askar/SQLite (Postgres is a Phase 1 concern). Register **both** v1 and v2 credential and proof protocols with the v1 ones present and the AnonCreds/LegacyIndy formats, per §2.7.1's "register both, negotiate v1" guidance. Register an endorser DID via von-network self-serve, publish a schema and a credential definition **without** `supportRevocation`. → *Accept:* schema and cred-def IDs readable in the ledger browser.

**S3 — Credo-to-Credo control.** A second Credo agent as holder, direct connection, no mediator. Issue and verify one credential. → *Accept:* full round trip green. **This step is not in the document and is the most valuable addition in this plan** — it separates "our issuer configuration is wrong" from "the native framework is incompatible". Every later failure is interpreted against this baseline.

**S4 — Mediator.** Compose stack with Postgres + Redis, Drizzle migration run as a separate container from the same image first, `forwardingStrategy: QueueAndLiveModeDelivery`, both HTTP and WS endpoints exposed. → *Accept:* mediator serves an OOB invitation and a Credo agent completes mediation coordination against it.

**S5 — Credo holder behind the mediator.** Repeat S3 with the holder routed through the mediator. → *Accept:* round trip green through the mediator. Isolates mediator config from holder-framework behaviour.

**S6 — Android.** Clone `aries-framework-kotlin`, build the sample app in `app/`, point it at our genesis and a mediator invitation, run connect → offer → accept → proof request → present. Instrument DIDComm message types at every hop so the negotiated protocol version and identifier forms are directly observable rather than inferred. → *Accept:* **Q1, Q2, Q3 answered with logged evidence.** If it stalls silently, that is the §11.11 symptom — bisect against S5.

**S7 — Offline delivery.** Force-close the app, issue, reopen. → *Accept:* **Q4 answered.** Note whether delivery required the socket to reopen first (the §2.7.3 implicit-pickup interaction).

**S8 — Mobile ledger reachability.** Repoint the sample at a public test network; test on cellular and on a restrictive Wi-Fi. → *Accept:* **Q5 answered**, with the `indy-vdr-proxy` fallback assessed if it fails.

**S9 — Fork feasibility probes.** Read (don't yet build) the two fork changes that are already known to be required: runtime genesis fetch instead of `assets.open()` (**Q7**), and the device-token path (**Q6**). → *Accept:* both answered as "straightforward / awkward / blocking", with the specific code sites named.

**S10 — Findings and gate.** Write `findings.md`: one section per question, the observed evidence, and the resulting configuration constant to be pinned in Phase 2. Then the gate.

---

## Gate criteria

**Pass** requires all of: S3, S5 and S6 green; Q1, Q2, Q3 answered with evidence; Q4 answered (a "no" is acceptable if S9 shows the push path is buildable); no blocking answer to Q6 or Q7.

**Conditional pass:** Android green, Swift pass outstanding. Phase 1 infrastructure may start; **Phase 5 SDK work may not**, and the gate stays open until the Swift pass completes.

**Fail:** the Kotlin holder cannot complete a round trip against a Credo 0.7 issuer even after the 0.5.x fallback. That triggers the §10 escalation — the holder strategy is reconsidered, not patched.

---

## Verification

- **S1:** `docker compose ps` all healthy; genesis endpoint returns 4 validator entries; ledger browser renders the domain ledger.
- **S2/S3:** the agent's Credo event stream reaches `done` on both credential and proof exchanges; assert the negotiated protocol is **v1** in the record, not just that it succeeded.
- **S4/S5:** mediation record created in the mediator's Postgres; message flows visible in mediator logs; round trip completes with the holder's DID document carrying the mediator routing key and endpoint.
- **S6:** `adb logcat` from the sample app plus issuer-side logs, correlated — capture the actual `@type` URIs of the exchanged messages, which is what proves v1 vs v2 and qualified vs unqualified identifiers.
- **S7:** timestamped log showing queue-then-deliver across an app restart.
- **S8:** connection success/failure to the validator client port from the device on each network, recorded per network type.

Every answer in `findings.md` cites the log excerpt it came from. Assumptions that were confirmed get marked Tier 1; anything still inferred stays Tier 2 and is called out as such.

---

## Explicitly not in Phase 0

Platform API, admin UI, multi-tenancy, Postgres-backed wallets, production ledger, secrets management, CI. The rig is throwaway. Its only outputs are answers and a gate decision.

## Document updates this should produce

Phase 0 should close by correcting [init.md](12id/init.md) rather than leaving it stale: the §7.1 package list and §2.7.1 class names (verified above), removal of revocation from §2.2/§4.7/§12.3, the §4.8 push-token gap, and the Phase 0 answers promoted from Tier 2 to Tier 1 in §0.1.
