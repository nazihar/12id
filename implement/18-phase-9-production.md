# Phase 9 — Production (plan)

**Status (2026-10-01):**
- W0 (this document and the updates to the other docs) is done.
- **W1 (close Phase 7) is done on staging.** Its evidence stays with each finding in `17-phase-7.md`.
- **W2 is done (2026-09-29): staging runs the bundle.** Evidence is in [`19-phase-9-production-findings.md`](19-phase-9-production-findings.md).
  - Staging runs the release bundle with file secrets and digest-pinned GHCR images, and every smoke passed unchanged.
  - `docker inspect` is clean.
  - Backups are pulled off-site and restored with the offline key only.
  - The production ledger stack was rehearsed as a scratch project on staging.
- **Open from W2:**
  - ~~GHCR namespace~~ decided: `ghcr.io/nazihar` (owner, 2026-09-29). Staging was moved there the same day with identical digests.
  - The owner's backup machine.
  - ~~`smoke:sdk-android` on the phone~~: passed 2026-09-30.
- **W3 is done (2026-10-01): the Android SDK is released on `maven.12id.com`.** The owner settled distribution and CI (W3 below): two SDK artifacts, a GitHub Pages Maven repository, and CI driven by tags.
  - Built: the native artifact (5b.1), the merged SDK artifact (5b.2) and the workflows (5b.3). **`smoke:sdk-android` passed with the rebuilt libraries on the phone (7/7) and on x86_64 emulators API 26/28/36.** Evidence in `19-…` W3.
  - **minSdk 24 kept (owner, 2026-10-01: the first customer requires it).** Android 7.0 lacks the Let's Encrypt roots; the SDK now carries them as a fallback (fork change F8) and passes the smoke on API 24.
  - **Released 2026-10-01:** `com.12id:holder-sdk-native:0.2.1-12id.1` (tag `native-v0.2.1-12id.1`, CI emulator matrix API 24/26/28/36 green) and `com.12id:holder-sdk-android:0.1.0` + biometric add-ons (tag `sdk-android-v0.1.0`) on `https://maven.12id.com`. The sample builds from there alone, and `smoke:sdk-android` passed 7/7 on the phone with that build.
  - **Carried over:** M15 (minisign on device) needs W5's production keys, so it lands with W5; it ships as an SDK release. The M10 phone check (re-onboarding after a `never_connected` revocation) is still owed. The image workflow (`release-images.yml`) first ran with `v0.1.0-rc.1` on 2026-10-04: one disk-space fix, then green (W5 step 0).
- **W4 ran on staging on 2026-10-04** (`19-…` W4). It deployed `v0.1.0-rc.1`, the first image release through CI, which is also W5 step 0's rc.
  - **A, load:**
    - Found and fixed a missing mediator index (`Did.alternative_dids`): 88 ms per poll became 0.17 ms.
    - **Staging's two mediator replicas carry about 600 open wallets.** Each replica tops out near 40 polls/s on Credo's per-message CPU (profiled), so **10k wallets need about 30 mediator cores**: an owner decision before go-live (below).
    - The agent's concurrency switch gives no gain at this scale (kept off); the Askar pool default (10) is enough.
  - **B, failover:**
    - Validators: 1 of 4 down, everything continues; 2 down, writes stop and the three alerts fire and arrive by mail.
    - A crashed mediator replica is back in 7–12 s with no message lost. Caddy now retries the other replica, so clients barely notice.
    - Open: the pickup delete-before-send window (accepted by the owner 2026-10-06, no patch) and one unexplained clean exit (`--trace-exit` is on).
  - **C, rotation:** every key class was rotated live on staging and every smoke passed. The rehearsal found three bugs, all fixed.
  - **D, DR:**
    - Every database restored with counts equal to live.
    - **The whole VM was rebuilt from the repo, a pulled backup and the offline key only in about 8 minutes** (WSL rehearsal, `dr-rebuild.sh`). It found `pg-roles.sh` failing on a fresh instance (fixed).
    - The gating drill against production stays after W5.
  - **Owner decisions:**
    1. **Mediator capacity for the target wallet count:** more replicas and hosts, a longer poll interval, and/or a cheaper mediator per message.
    2. ~~**The delete-before-send window:** accept it, or a `-p7` patch.~~ **Accepted (owner, 2026-10-06):** it is rare (only a mediator crash between taking and sending a batch; 1 of 897 messages in one disturbed run, 0 in clean runs) and recoverable (the exchange is abandoned by reconciliation and offered again). No patch.
- **W5 step 0 done 2026-10-05: `v0.1.0` is released.** `-rc.1` (2026-10-04) and `-rc.2` were built by CI; `-rc.3` (commit `4dd3680`, + the W7 expiry guard) passed on staging: every service healthy, `docker inspect` 0, 22/22 targets, `smoke:platform-credo`, `smoke:biometric-credo` 18/18 and `e2e:staging` 3/3. `v0.1.0` on the same commit added `0.1.0` to the same nine digests (checked against `release-0.1.0.env`, no rebuild). Production (W5 step 4) deploys `release-0.1.0.env` from the GitHub release.
- **W7 written and published 2026-10-05 at https://docs.12id.com** (`19-…` W7): `credential-model.md` (new) and a revised `data-protection.md`, published at `docs.12id.com` once the owner's one-time setup is done. Found: credential expiry is capped at 2038-01-19 by 32-bit predicates (offers past it are now refused; owner decision whether to keep that unit).
- **Next:**
  - **W5**, production bring-up. It needs from the owner the production VM (sized from W4 decision 1), DNS for `12id.com`, an SMTP account, the production offline age key, trustee custody, and the backup machine.
  - **M15** with W5's minisign keys.
  - The DR drill against production.
  - W6 (iOS) when the hardware arrives.
- **Done as of 2026-10-06:** W0–W4 on staging, W7 written, M15 built and phone-tested (SDK 0.3.0, unreleased: it needs W5's keys), and the production VM sized (`19-phase-9-production-findings.md`, "After v0.2.0"). **Found by the sizing runs, open:** agent-service message lookups slow down with a tenant's stored exchanges (5.4 s at 1,160), and the edge's per-IP limits throttle SDK polling. **Left before go-live:** W5, the M15 release, the production DR drill, W6. Mediator load follows exchanges, not open apps (on-demand delivery, `20-on-demand-delivery.md`). **Decided 2026-10-06:** the delete-before-send window is accepted; expiry is a date (`expiresOn`, needs platform `v0.2.0` + SDK 0.2.1); the hosting country is agreed per customer.
- **2026-10-08: the slow message lookups are fixed and released as `v0.2.1`** (`19-…`, "The slow message lookups: fix"). The agent's database role plans each Askar query for its values (`pg-roles.sh`), and agent-service deletes a finished exchange's stored messages once the platform has acknowledged the final state. On staging the same load went from 15.5 to 77 exchanges a minute (offer → done p50 25.2 s → 2.0 s), and the first run deleted 6,829 stored messages. Staging runs `0.2.1-rc.1`; **production (W5 step 4) deploys `release-0.2.1.env`**. Still open: the edge's per-IP limits (they caused a 30 s tail for five holders behind one address), and the one uncollected offer. Every smoke passed on it, `smoke:sdk-android` on the phone included.
- **2026-10-08: the edge's per-IP limits for phones are raised, on staging only** (`19-…`, "The edge's per-IP limits for phones"). A phone makes about 56 mediator requests in the minute it onboards, so the old 300 a minute allowed about 5 phones a minute behind one address. Now: mediator 500 per 10 s, agent 200 per 10 s (`EDGE_MEDIATOR_LIMIT`, `EDGE_AGENT_LIMIT`). The same load went from 77 to 143.5 exchanges a minute and its p95 from 29.4 s to 3.0 s, with nothing declined. **It is not in a release yet: the next platform release carries it, and production must deploy that one.** Still open: the one uncollected offer (none lost in today's 1,119 load exchanges), and the SDK's behaviour on a 429.

## Context
Phases 0–6 are built and verified on the staging VM `id-dev` (`*.12id.naziharitsolution.com`, [`4-init-post-phase-0.md`](4-init-post-phase-0.md) §10):
- ledger (von-network), patched mediator, agent-service + endorser-service, platform-api, console, biometric-service;
- the Android holder SDK (`com.12id:holder-sdk-android`, `com.onetwoid.sdk.OneTwoId`).

Phase 7, the pre-production review ([`17-phase-7.md`](17-phase-7.md)), was almost done when this plan was written (it is done now, see the status above):
- H2, H3, K1 and every Medium are done on staging, except M11, M13 and M17.
- **H1 (deletion and retention) and the Low batch are still open.**
- The owner kept M11 (file secrets), M13 (off-site backups) and M17 (tags and CI) open for "the production host". This phase closes them.

No production environment exists. Until now these decisions were deferred: the ledger (§12.1), the host, the domain, secrets, backups and the go-live scope. They were taken on 2026-09-28 (below).

**Outcome:** a production environment on `*.12id.com`, running a released, digest-pinned build. It has our own Indy network, off-site backups, file-based secrets, a published Android SDK, and an iOS SDK. Every item in the go-live gate below passes.

## Decisions (2026-09-28)
| Item | Decision | Consequence |
|---|---|---|
| Ledger (§12.1) | **Our own Indy network, full control.** No third-party network, no von-network. Official `indy-node-container` images; fresh random node and steward keys; trustee keys kept offline | Validator operations are ours. No TAA is needed on our own network (documented choice). The production did:indy namespace is ours (proposed `twelveid`) |
| Validator placement | **All 4 validators on the app VM for now** | Keys are secure, but availability is the same as staging: if the VM goes down, so does the ledger. Moving a validator to its own host later is a NODE transaction plus a genesis rotation ([`genesis-rotation.md`](../infra/runbooks/genesis-rotation.md)) |
| Hosting | **One fresh, dedicated VM** with the same Docker Compose + Caddy stacks as staging. Self-hosted, no outside vendor | Size it after the Phase 8 load test. Starting point: 8 vCPU / 32 GB |
| Domain | **`12id.com` subdomains:** `api.`, `agent.`, `mediator.`, `genesis.`, `vdr.`, `maven.`, and **`console.12id.com`** | The apex stays the marketing site. `maven.` is a CNAME to GitHub Pages, not a site on the VM (W3, 2026-09-30) |
| Secrets (M11) | **Root-only files on disk** (`/opt/12id/run-secrets`, mode 600). Services read `*_FILE` | Containers restart unattended after a reboot, and secret values leave `docker inspect`. A decrypted copy is at rest on the disk, like the age key already is |
| Backups (M13) | **A backup machine at another site pulls nightly over SSH.** Its key can only read `/opt/12id/backups`. It keeps 30 daily + 12 monthly. A **second age recipient** has its private key offline | A compromised production VM cannot delete the off-site copies. Backups decrypt even if the VM and its age key are both lost |
| Images | **Prebuilt only; nothing is built on any VM.** GHCR, `ghcr.io/nazihar/12id-*`. A release-candidate tag `vX.Y.Z-rc.N` builds and pushes `sha-<short>` + `X.Y.Z-rc.N`; the tag `vX.Y.Z` on the same commit adds `X.Y.Z` to the same digests (tags, not merges: owner, 2026-09-30). **One platform version** for services, console, console-tools, ledger-tools and the patched mediator; the mediator's upstream base and patch level go in image labels. The SDKs get their own semver | Closes M17's mutable tags. "What is running" is answered by `services/VERSIONS.md` |
| Promotion | `X.Y.Z-rc.N` on staging → smokes pass → tag `vX.Y.Z` → production pulls **`X.Y.Z@sha256:…`** | Rollback = redeploy the previous digest. Migrations stay backward compatible for one release. The VMs pull with a read-only `read:packages` token, stored as a secret |
| Self-hosting (§12.15) | **Production deploys from the same release bundle a self-hosting customer would get:** image-only compose files, one env template, `release.env` | Every production deploy tests the self-host path. The `init` command and the self-host guide are a later packaging phase; go-live does not wait for them |
| SDK trust anchor (M15) | **Configurable** minisign public keys in `OneTwoIdConfig`. The default is 12id's production keys (primary + backup), compiled in | A self-hosting customer uses their own genesis key without a custom SDK build |
| Go-live gate | **H1, the Android SDK release (5b), Phase 8 load + DR, and iOS** | iOS is blocked on hardware: no Mac, Apple developer account or iPhone yet (owner action) |

## Facts this plan builds on
- **von-network is not a production ledger** (source read, `phase0/von-network`, 2026-09-28):
  - Its genesis is generated by `generate_indy_pool_transactions` (`bin/von_generate_transactions:98`), which uses fixed test seeds.
  - The Trustee is `000000000000000000000000Trustee1`, DID `V4SGRU86Z58d6TV7PBUe6f`. It is published in its own docs (`docs/AddNewNode.md:825`) and is the `LEDGER_SEED` default (`manage:922`).
  - The client ports must be public so that phones can read the ledger. So anyone who knows the seed can write as Trustee: create stewards and endorsers, publish under any DID, change the pool. This is true on staging today (new finding **L16** in `17-phase-7.md`).
  - Also: an unauthenticated `/register` write endpoint (blocked at our edge), a ledger browser, old pinned indy-node, no upgrade, key-rotation or backup procedure, and `./manage down` deletes the ledger volumes.
- **Hostnames are hardcoded** in 33 files outside `implement/`. The ones that matter are `infra/staging/Caddyfile`, the `compose.*.yml` files and `monitoring/prometheus.yml`. The services and the console already read their URLs from the environment; the matches there are tests, smokes and examples.
- `infra/scripts/deploy.sh` already takes `ROOT` and decrypts SOPS files to `/dev/shm` for `--env-file`. That interpolation is exactly what puts secrets into `docker inspect` (M11).
- Staging builds every image on the VM from a tarball of the source (`build:` in the compose files, mutable tags `phase7`/`phase6`). Only the mediator starts from a published image (`mediator:375518d`), which is patched on the VM.

## Freeze before the first real wallet or tenant
These values get written into ledgers, wallets or SDK binaries. Changing them later means re-onboarding tenants or an app update for every user:
- the mediator and agent hostnames (in every wallet's connections and DID documents);
- the genesis URL;
- the did:indy namespace (proposed `twelveid`);
- the endorser DID;
- the production minisign public keys, the SDK's default trust anchor.

## Workstreams
W2, W3 and W5 can partly run in parallel. W6 waits on hardware.

### W0 — Record the plan ✅ 2026-09-28
- This document.
- `4-init-post-phase-0.md`: §0.1 von-network note, §10 Phase 9 entry, §12.1 decided, new §12.18.
- `17-phase-7.md`: finding L16.

### W1 — Close Phase 7 (on staging) — ~4 d ✅ 2026-09-28
> **Status 2026-09-28: H1 done on staging, with L5.**
> - Owner decisions: scrub, never delete; 90-day default retention; operators masked, with an audited reveal; operator-created keys flagged. Evidence in `17-phase-7.md` §2 H1.
>
> **Status 2026-09-28 (later): the Low batch is done on staging.** L1, L4, L6, L7, L13, L14, L15, I1 and I2 are done; each has its evidence in `17-phase-7.md`, with the summary in §10 row 14.
> - Staging leftovers:
>   - `AGENT_INTERNAL_TOKEN` is removed from `agent.sops.env` (VM and repo);
>   - the owner's `CONSOLE_TOKEN` is back in the VM's `platform.sops.env`, which matches the repo.
> - **Done later the same day, at the owner's request ("complete W1"):**
>   - **L10:** the console audit now records what each change was, with secrets and personal data replaced (`17-phase-7.md` L10).
>   - **The old `endorser` database is dropped** from the mediator instance, one day early. It was dumped encrypted first and a scratch restore matched it (`infra/runbooks/postgres-roles.md`).
>
> **W1 is complete.** Phase 7's own work is done on staging. The findings still open belong to later workstreams: L2, L16, M11, M13 and M17 to W2; M15 to W3; L9 to W4; L8 is the owner's rotation; L12 waits for the next Credo release. The go-live gate's "H1 on production" comes with W5.
> - **L11 done the same day (owner decision: 7 days is a security concern).** Every console session now ends 24 h after sign-in, and operators keep 12 h. Activity does not extend a session. `e2e:staging` passed 3/3.
> - **Found on staging while verifying.** Neither was caused by the Low batch; both were firing before it:
>   - **`indy-vdr-proxy` does not recover from a failed pool start.** It logged `Pool timeout` and hung on every request from 2026-09-27 12:48 until a manual `docker restart`. `EndpointDown` fired all that time. For W2: give it a healthcheck on `/genesis` and a restart policy that acts on it (for example autoheal, or a probe that exits).
>   - **cAdvisor's `/metrics` takes more than 20 s**, so `TargetDown` has flapped since about 2026-09-26 23:58. Not investigated; the container reports healthy.
>   - `WebhookBacklogStuck` was 5 `record.erased` deliveries from the H1 staging test. They went to the biometric smoke tenant's URL, which answers 502 unless a smoke is running. They go dead on their own after 12 attempts, so this is expected on staging.
>
> The plan as written:

- **H1** (`17-phase-7.md` §2 H1, fix a–c):
  - `DELETE /v1/credentials|proofs|connections/{id}` (API key; deletion is an integration action). It scrubs the mirror rows, nulls the webhook bodies, and calls a new agent-service route that deletes the Credo exchange record.
  - A per-tenant retention setting (default 90 d), enforced by the hourly job pattern of `services/platform-api/src/sweep.ts`. It covers:
    - the mirror tables and the `webhook_deliveries` bodies;
    - agent-service `outbox`;
    - `exchange_gates` / `exchange_gate_events`;
    - biometric-service `checks` / `sessions` / `results`.
  - Purge expired Better Auth `session` / `verification` / `rate_limit` rows.
  - Migrations numbered after `0008`.
- **Low batch:**
  - L1 headers;
  - L4 attribute caps;
  - L5 retry guard;
  - L6 the startup invitation (mediator patch `-p6`);
  - L7 `webhook-sink` → `profiles: [debug]`;
  - L13 Valkey `allkeys-lru`;
  - L14 catalogue TTL cache;
  - L15 `Cache-Control` on `/v1/ledger`;
  - I1 `isProduction` from the environment (`agent-service/src/agent/root-agent.ts`);
  - I2 narrow the exemption to `10.1.1.1/32` (staging; production sets its own);
  - L10 and L11 only if cheap.
- **Staging leftovers:**
  - drop the old `endorser` database on the mediator instance (after 2026-09-29);
  - remove `AGENT_INTERNAL_TOKEN`;
  - the owner restores `CONSOLE_TOKEN` in the VM's `platform.sops.env`.
- Docs rule: a dated back-note in the origin phase doc plus the note in `17-phase-7.md`.

### W2 — Make the infra production-capable (rehearsed locally and on staging) — ~5 d ✅ 2026-09-29
> **Status 2026-09-29: done; staging switched.** Evidence and traps: `19-phase-9-production-findings.md` W2.
>
> **Deviations from the plan as written:**
> - The services and console Dockerfiles stay next to their sources. `infra/build/compose.build.yml` holds every build definition, and the infra-owned Dockerfiles moved to `infra/build/`.
> - The genesis is built by the ceremony image with indy-plenum's own transaction builders. `genesis_from_files.py` is not in indy-node 1.13.2 or its image.
> - Secret files are `root:12000 0440` in a root-only directory, and each reading container runs with `group_add: 12000`. The containers don't run as root, so the literal "root 600" would not have been readable.
> - The ceremony lives in `compose.ledger-nodes.yml` (`run --rm ceremony`).
> - Staging's L2 stays as it was; production has no public ledger browser or Grafana.
> - The local rehearsal stopped on the dev PC's full disk. The ledger was rehearsed as a scratch project on staging, and the images were built there once, by owner decision.
>
> The plan as written:

1. **Per-environment config:**
   - one set of `compose.*.yml`;
   - the hostnames move into a non-secret `infra/env/<env>.env` (`API_HOST`, `CONSOLE_HOST`, `MEDIATOR_HOST`, …), and the Caddyfile uses `{$VAR}`;
   - `deploy.sh` gains `ENV=staging|production`, which selects `ROOT`, the secrets directory and the env file.
   - Passes when staging re-passes every smoke with no behaviour change.
2. **M11 file secrets:**
   - services and the console read `X_FILE`: a helper next to the env parsing in `services/credo-base` and `console/src/server/env.server.ts`;
   - Postgres uses `POSTGRES_PASSWORD_FILE`;
   - the mediator gets a small entrypoint wrapper, which keeps its values out of `docker inspect` but not out of its own `/proc/<pid>/environ` (accepted, `17-phase-7.md` M11);
   - `deploy.sh` decrypts SOPS into `/opt/12id/run-secrets/<stack>/` (root 600) instead of `--env-file`.
   - Passes when `docker inspect` shows no secret value on any container.
3. **M17 minus CI: image-only, bundle-shaped compose:**
   - no `build:` in the deploy compose files; the build definitions move to `infra/build/` for CI only (the services Dockerfile, `console/Dockerfile`, the mediator's `Dockerfile.patched`, `infra/ledger`);
   - image lines read `${REGISTRY}/12id-<name>:${VERSION}@${DIGEST_<NAME>}` from `release.env`;
   - base images (`postgres:15-alpine`, `valkey:8-alpine`, `node:22-alpine`, caddy, indy-node) are pinned by digest;
   - compose + env template + `release.env` = the **release bundle**;
   - until W3's CI exists, `infra/scripts/release.sh` builds and pushes to GHCR by hand, so staging switches early.
4. **M13:**
   - a second age recipient in `.sops.yaml` and in `infra/scripts/backup-postgres.sh`;
   - `infra/scripts/backup-pull.sh` for the backup machine: `rsync` over SSH, `authorized_keys` restricted with `command=` / `rrsync -ro` to `/opt/12id/backups`, local retention 30 daily + 12 monthly;
   - drill: restore from the pulled copy with the offline key only.
5. **Production ledger stack** `compose.ledger-nodes.yml`:
   - 4 `indy-node-container` validators;
   - `node_ip` on the internal Docker network, so node ports are never published;
   - `client_ip` public on 9702/9704/9706/9708, which removes the staging hairpin and the `DOCKER-USER` trap;
   - **genesis ceremony** in `ledger-tools`:
     - random seeds are generated inside the ceremony container and never printed;
     - trustee and steward DIDs go to `trustees.csv` / `stewards.csv`, and indy-node's `genesis_from_files.py` builds the pool and domain genesis;
     - trustee keys are exported to offline custody (3 trustees if the owner can hold them separately);
   - **trustee-signed endorser bootstrap:** `bootstrap-endorser` (`infra/ledger`) writes NYM(role=ENDORSER) signed with a trustee key loaded once from offline media, replacing von-network's `/register`;
   - `vdr-proxy` on the new genesis;
   - the write probe and client-port alerts carry over;
   - **no public ledger browser or Grafana** (L2): SSH tunnel only.
   - Rehearse locally (Docker Desktop), then as a scratch Compose project on staging.
6. **Runbooks:** new `infra/runbooks/ledger-ceremony.md` and `production-bringup.md`; `genesis-rotation.md` gains "move a validator to its own host".

### W3 — Android SDK release and CI (Phase 5b, `17-phase-7.md` Appendix A) — ~6–8 d ✅ 2026-10-01 (except M15, which waits for W5's keys, and the M10 phone check; the image workflow first ran 2026-10-04)

**Decided (owner, 2026-09-30).** The aim is to keep things simple for the customer and for us, with as little configuration outside the repo as possible.

| Item | Decision | Why |
|---|---|---|
| Artifacts | **Two artifacts, and the customer declares one.**<br>• `com.12id:holder-sdk-android` is the SDK, the fork (its sources merged into the SDK module and no longer published on their own) and the vendored `java-multibase`. About 3 MB.<br>• `com.12id:holder-sdk-native` is the three rebuilt UniFFI wrappers (Askar, AnonCreds, Indy VDR) in one AAR: the `.so` files for arm64-v8a, armeabi-v7a and x86_64, plus their Kotlin bindings. About 20 MB. It arrives transitively | One coordinate for the customer, and the SDK and the fork can never drift apart. The native part changes only with an Askar, AnonCreds or VDR bump, so SDK releases stay small (the Pages limit is 1 GB) |
| Wrapper sources | Build scripts in the monorepo (`sdk-android/native/`), pinned to an upstream tag. **No separate GitHub fork** | Same pattern as the vendored `ariesframework` |
| Public repository | **A static Maven repository on GitHub Pages.** It is a public repo, `nazihar/12id-maven`, that holds only built artifacts, and it is served at `maven.12id.com` via a CNAME. This replaces "a static repo behind the production Caddy" | GitHub Packages' Maven registry needs a token even for public packages (GHCR does not), and we cannot ask customers for one. Pages needs no VM, costs nothing, and needs no customer token. The custom domain lets us move to Maven Central later without breaking a consumer |
| CI triggers | **Tags, not merges:**<br>• pushes to `master` and PRs run checks only;<br>• `vX.Y.Z-rc.N` builds every image once and pushes `sha-<short>` + `X.Y.Z-rc.N`, and staging deploys it;<br>• `vX.Y.Z` on the same commit retags those digests with no rebuild;<br>• `sdk-android-vX.Y.Z` publishes the SDK;<br>• `native-vX.Y.Z` rebuilds and publishes the wrappers | Production runs the digests staging tested. GHCR does not collect an image for every commit |
| Actions minutes | `nazihar/12id` is private on a free account, so it gets 2,000 minutes a month. The emulator matrix and the Rust build run on tags or by hand, never on every push | |

**The customer's setup:**
```kotlin
// settings.gradle.kts
repositories { google(); mavenCentral(); maven("https://maven.12id.com") }
// app/build.gradle.kts
implementation("com.12id:holder-sdk-android:X.Y.Z")
```

**The owner's one-time setup outside the repo:**
1. Create the public repo `nazihar/12id-maven` (renamed from `maven`, 2026-10-01) and turn on Pages (deploy from its default branch, `master`).
2. Add a DNS record: `maven.12id.com` CNAME to `nazihar.github.io`, then set the custom domain and "Enforce HTTPS" in Pages. GitHub's DNS check hung for a day with correct DNS; re-saving the domain restarted it and the certificate followed within the hour.
3. Add one Actions secret in `nazihar/12id`, `MAVEN_REPO_TOKEN`: a fine-grained PAT with Contents: read and write on `nazihar/12id-maven` only.
4. ~~Tag ruleset~~: not available for private repos on GitHub Free; the owner is the only one who can push, so it waits for a paid plan or a second contributor.
5. For each of the nine `ghcr.io/nazihar/12id-*` packages, open Package settings → Manage Actions access, and add `nazihar/12id` with the Write role. The packages were first pushed by hand in W2, so the workflow's token may not write to them until this is done.

GHCR needs no secret: the workflow's `GITHUB_TOKEN` pushes to `ghcr.io/nazihar` once step 5 is done.

**Steps:**
- **5b.1: the native artifact** (finding 9, trap 42):
  - rebuild Askar, AnonCreds and Indy VDR from upstream `aries-uniffi-wrappers` tag `0.2.1`, the sources of the three published wrappers, with its `Cargo.lock`;
  - use `cargo-ndk` and NDK r27 at API 24, whose clang links compiler-rt's builtins, so `__extenddftf2` resolves on x86_64;
  - build three ABIs and drop x86;
  - libc++ is linked statically, so the upstream `libc++_shared.so` goes away;
  - reuse the upstream Kotlin bindings (`classes.jar`, generated code, Apache-2.0) unchanged. The Rust sources are identical, and UniFFI checks its API checksums when a library loads;
  - package everything as `com.12id:holder-sdk-native`, and retire `scripts/mirror-uniffi.ps1` and `third_party/m2`;
  - acceptance: the sample onboards on x86_64 emulators at API 24, 26, 28 and 36, and `smoke:sdk-android` still passes on the phone.
- **5b.2: the SDK artifact and the repository:**
  - merge the fork's sources into `:sdk`. The `ariesframework` module stays for its own tests and is not published. `apiDump` ignores `org.hyperledger.*`;
  - vendor `java-multibase`, which removes JitPack;
  - publish to a local directory in Maven layout. CI copies it into `nazihar/12id-maven`;
  - the sample resolves only from that repository, and `docs/integration.md` shrinks to the snippet above.
- **M15: minisign verification of the genesis on the device:**
  - the trust anchor is configurable: `OneTwoIdConfig` takes one or more minisign public keys;
  - the default is 12id's production keys (primary + backup), compiled in;
  - the key and URL from `/v1/ledger` stay hints only;
  - `apiDump` for the new parameter;
  - depends on W5 step 2, which generates the production keys.
- **5b.3: CI on GitHub Actions** (GitHub-hosted runners):
  - checks on pushes to `master` and on PRs, filtered by path:
    - services: `tsc` + tests + `npm audit --omit=dev --audit-level=high` (what ships; L12);
    - console: `tsc` / Vitest / `check:client`;
    - SDK: build + JVM tests + `apiCheck`;
  - the release workflows above;
  - the emulator job (x86_64, API 24/26/28/36, `native/src/androidTest`: all three libraries load and answer a call) runs on `native-v*` and by hand. The native libraries are what differ between ABIs and API levels, so an SDK release runs the JVM tests, `apiCheck` and a sample build from the published artifacts instead;
  - `sdk-android-v*` and `native-v*` publish into a checkout of `nazihar/12id-maven` (so `maven-metadata.xml` keeps every version), refuse a version that already exists, and push. `sdk-android-v*` attaches the API dump to the GitHub release;
  - the workflows are `.github/workflows/ci-{services,console,sdk-android}.yml` and `release-{images,native,sdk-android}.yml`.
- Phone checks still owed: ~~`smoke:sdk-android` (M14, the M1 mediator cap)~~ **passed 2026-09-30** (`19-phase-9-production-findings.md` W2), and re-onboarding after a `never_connected` revocation (M10).

### W4 — Phase 8 Hardening (production-shaped staging; the DR drill against production) — ~5–6 d ✅ on staging 2026-10-04 (the DR drill against production follows W5)
> **Status 2026-10-04:** load, failover, rotation and DR all ran on staging. Results and the two owner decisions are in the status at the top and `19-…` W4.
- **Mediator load test** with the real profile:
  - N wallets running `PickUpV1` every 10 s, plus one webhook per queued message;
  - scripted Credo holders, ramped from 1k to 10k;
  - measure CPU, Postgres, WebSocket count and latency.
  - It settles `agent_per_ip` / `mediator_per_ip` (M1), `PROCESS_MESSAGES_CONCURRENTLY` and the Askar pool (L9), M2's numbers, and the production VM size.
- **Failover:**
  - kill one validator (reads and writes continue), then two (writes stop and the alert fires);
  - kill one mediator replica during delivery (the queue and the webhooks survive).
- **Key rotation runbook:**
  - the endorser key (a new endorser DID plus re-binding);
  - Askar store keys;
  - `CONSOLE_TOKEN`, `PLATFORM_AGENT_TOKEN`, `AGENT_ENDORSER_TOKEN` and the admin tokens;
  - `BETTER_AUTH_SECRET`;
  - the biometric master key;
  - the age key;
  - the minisign key: a new genesis signature, while the SDK's compiled-in anchor needs an app release, hence the backup key;
  - TLS.
- **DR runbook + drill:**
  - scenarios: lose the endorser key, a wallet database, the mediator queue, the whole VM;
  - the drill rebuilds the full stack on a scratch VM from the backup machine's copy, with the offline age key only, including the ledger node data.

### W5 — Production bring-up (after W1 + W2; its minisign keys complete W3's M15) — ~3 d
0. **The first image release through CI** (`release-images.yml`, written in W3, never run yet):
   - one-time: connect each of the nine `ghcr.io/nazihar/12id-*` packages to `nazihar/12id` (Package settings →
     Connect repository). They were first pushed by hand in W2, so the source label alone does not link them, and the
     link is what gives the workflow's `GITHUB_TOKEN` write access;
   - tag `v0.1.0-rc.1`: CI builds the nine images once and pushes `sha-<short>` + `0.1.0-rc.1`; expect to tune
     the runner (disk space, as for the native build) on the first run;
   - deploy `release-0.1.0-rc.1.env` (from the GitHub pre-release, committed as `infra/compose/release.env`) on
     staging and run every smoke. Staging pulls from GHCR slowly (~21 KB/s, W2): bring large images over through the
     PC if needed;
   - tag `v0.1.0` on the same commit: CI adds `0.1.0` to the same digests (no rebuild) and attaches the bundle;
     production (step 4) deploys it.
1. **Provision and harden the VM:**
   - key-only SSH, ufw (22/80/443 + the 4 client ports), fail2ban, unattended-upgrades;
   - Docker pinned;
   - its own age key, plus the offline second recipient;
   - **fresh secrets for everything**; nothing is copied from staging.
2. **Freeze and generate:**
   - DNS;
   - the production minisign keypair (the public key goes to W3);
   - the namespace `twelveid`.
3. **Ledger:**
   - run the ledger ceremony;
   - publish genesis v1, signed, at `genesis.12id.com/v1/…`;
   - bootstrap the endorser with the trustee key, then put the trustee keys back offline.
4. **Deploy every stack from one release bundle** (`vX.Y.Z`, digest pinned, pulled from GHCR):
   - edge, mediator (+ `mediator-indexes`), agent (+ provision), platform, biometric, console, monitoring;
   - `pg-roles.sh`;
   - `isProduction: true`;
   - alert mail through the owner's `12id.com` SMTP;
   - operator accounts (TOTP) through console-tools.
5. **Backups:** the nightly job, the backup machine's pull, and a restore drill from the pulled copy.
6. **Production smoke with a throwaway tenant:**
   - `smoke:platform-credo`, `smoke:biometric-credo` (mock), the console e2e against `console.12id.com`, and `smoke:sdk-android` on the phone;
   - the edge probes of `17-phase-7.md` §4;
   - then remove the tenant. Its ledger objects stay, which is accepted and documented.

### W6 — iOS (blocked on a Mac, an Apple developer account and an iPhone) — ~3–4 weeks once unblocked
- Swift pass: the §2.7.4 fork changes, `PickUpV1`, the `did:sov` prefix, and the Phase 0 checklist.
- **Delivery model** (on-demand delivery, 2026-10-05, [`20-on-demand-delivery.md`](20-on-demand-delivery.md)): mirror Android 0.2.0. No polling timer; windows after `connect` / `acceptOffer` / `expectMessages`; one drain on foreground; `sync()` plus a 32 s tail. iOS throttles silent background pushes, so the drain on foreground carries more of the delivery there.
- SDK mirroring `com.onetwoid.sdk.OneTwoId`:
  - the AWS biometric add-on;
  - SPM distribution from a self-hosted git or static URL;
  - minisign with the same configurable anchor.
- Parity suite in CI (needs a macOS runner).

### W7 — Customer-facing documents — ~2 d (after H1) — ✅ written and published 2026-10-05 at https://docs.12id.com (hosting country: agreed per customer, owner 2026-10-06)
> **Status 2026-10-05:**
> - **Written:**
>   - `services/platform-api/docs/credential-model.md` (new): validity and expiry, no revocation, wallet recovery, attribute-encoding recipes and a schema checklist.
>   - `data-protection.md` revised: off-site backups and their effect on erasure, hosting, sub-processors and a security-measures overview.
>   - `api.md` and the SDK guide linked to it and cleaned of internal paths.
> - **Found while writing:** an `expiresAt` after 2038-01-19 was accepted, but AnonCreds hashes integers outside 32 bits, so every proof of such a credential would fail. Offers now refuse it (agent-service `builders.ts`, tests).
>   - ~~**Owner:** this caps credential validity at 2038; decide before the first customer.~~ **Decided (owner, 2026-10-06): expiry is now a date.** The mandatory attribute is `expiresOn` = `YYYYMMDD` (UTC), accepted through the end of that day; proofs check `expiresOn >= today`; any date to 9999. Clean break: `expiresAt` (epoch seconds) is retired, with no compatibility path (staging test data only). Code: agent-service `builders.ts` (`isCalendarDate`, `utcDateNumber`), platform-api `views.ts` `expiryOf` (the next midnight UTC), the console, smokes; the SDK reads `expiresOn` into the unchanged `expiresAtEpochSeconds` (0.2.1). Needs a platform release (`v0.2.0`) and SDK 0.2.1.
> - **Published (owner decision): `docs.12id.com`**, a GitHub Pages site in the public repo `nazihar/12id-docs`, assembled by `docs/site/build.sh` and published by `.github/workflows/docs.yml` on every docs change. Pages: the guides, the API reference (Redoc, pinned with SRI) and `openapi.json`. The workflow skips until the setup below exists.
> - **Owner's one-time setup** (as for `maven.12id.com`, W3):
>   1. create the public repo `nazihar/12id-docs` and turn on Pages from `master`;
>   2. DNS `docs.12id.com` CNAME `nazihar.github.io`, then the custom domain and "Enforce HTTPS" in Pages;
>   3. Actions secret `DOCS_REPO_TOKEN` in `nazihar/12id`: a fine-grained PAT, Contents read/write on `nazihar/12id-docs` only;
>   4. run the `docs` workflow once by hand.
> - ~~**Owner, before publishing:** the hosting country in `data-protection.md`.~~ **Decided 2026-10-06:** it varies by customer; the guide now says it is agreed per customer in the data-processing agreement (self-hosting: the customer's own servers).

The plan as written:
- The §5.3 data-protection posture:
  - what deletion and retention actually do;
  - the ledger holds no PII;
  - mediator metadata;
  - biometric data, with the tenant as controller and responsible for consent.
- The no-revocation and expiry model, the wallet-recovery story ("accept loss, re-issue"), and attribute encoding (§5.2).
- Publish the API docs (`services/platform-api/docs/api.md`, `openapi.json` at `api.12id.com`) and the SDK integration guides.

### Later phase — Self-host packaging (§12.15; not in the go-live gate)
- An `init` command in the `ledger-tools` image does first-time setup in one guided run:
  - generate every secret into the run-secrets layout;
  - run the ledger ceremony, or take an existing genesis plus a trustee or endorser;
  - create the Postgres roles (trap 49);
  - bootstrap the endorser;
  - create the first operator.
- A self-host guide: DNS/TLS for the hostnames, sizing, upgrades (`pull` + `up -d` with the next bundle), backups, and the SDK trust-anchor configuration.
- Image access for customers: public GHCR packages or per-customer pull tokens.

## Owner actions (not code)
- The production VM, the backup machine at the other site, and a Mac, an Apple developer account and an iPhone.
- An SMTP account on `12id.com` (console invitations, password resets, alerts).
- Custody of the trustee keys and the offline age key: who holds them, and where.
- Rotate the AWS keys in `biometric.sops.env`, the Gmail app password, and the `console/.staging` credentials (L8). Confirm that the M16 alert mails arrived.
- Legal: privacy policy, terms, DPA (these use W7).

## Order
W1, W2 and W3 are done (W3 released the SDK on 2026-10-01). Next is W5, which generates the production minisign keys; an SDK release with M15 follows. W4 runs on production-shaped staging as soon as W2 lands; its DR drill runs after W5. W7 follows H1. W6 starts when the hardware arrives.

## Go-live gate
- **Phase 7 closed:** H1 is on production, and the Low batch is done.
- **Production:**
  - the W5 smokes pass;
  - `docker inspect` is clean;
  - every image comes from one GHCR release `vX.Y.Z`, pinned by digest (no `build:` on the VM, base images pinned by digest);
  - the edge probes pass;
  - the alerts fire and arrive by mail;
  - backups are pulled off-site and restored with the offline key.
- **Android SDK:**
  - the sample builds from `maven.12id.com` with a clean Gradle cache;
  - the emulator matrix and the phone smoke pass;
  - minisign is verified on the device.
- **Phase 8:**
  - the load test meets the target wallet count;
  - validator and mediator failover pass;
  - the rotation and DR runbooks are written;
  - the DR drill passes.
- **iOS:** the Swift pass succeeds, the iOS SDK smoke passes on an iPhone, and the parity suite is green.
- **Customer documents** are published.

## Verification
Verification works as in Phases 1–7:
- unit tests: platform-api, agent-service, endorser-service, console Vitest, SDK JVM + `apiCheck`;
- the staging smokes after each deploy: `smoke:platform-credo`, `smoke:biometric-credo`, console `e2e:staging` 3/3, and `smoke:sdk-android` on the phone;
- probes: curl, `docker inspect`, `psql` as each role;
- evidence goes in `19-phase-9-production-findings.md`.

W2 has passed when staging re-passes every smoke unchanged. W5 has passed when the same smokes pass against `*.12id.com`.

## Document updates
- `4-init-post-phase-0.md`: §0.1, §10 Phase 9, §12.1, §12.18 (done in W0). Each workstream adds its result to §10 Phase 9 when it lands.
- `17-phase-7.md`: L16 (done in W0); H1, the Low batch, M11, M13 and M17 get status notes when they land.
- The origin phase docs get dated "Phase 9 update" back-notes, following the Phase 7 rule.
