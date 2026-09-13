# Phase 1 — Infrastructure (staging)

## Context
Phase 0 passed conditionally on Android (`12id/3-phase-0-findings.md`). `12id/4-init-post-phase-0.md` §10 lists Phase 1 as infrastructure. The `phase0/` rig works but is throwaway: it runs on one Windows machine, uses a LAN IP, plain `ws`/`http`, dev passwords in compose files and no monitoring.

Phase 1 turns it into a reproducible, TLS-fronted **staging environment on a cloud VM**. It also closes the Tier-"not yet tested" items that only real infrastructure can answer:
- `wss`/`https` endpoints
- whether the mediator webhook fires
- multi-instance mediator delivery
- a hedge for corporate networks blocking Indy client ports

**Outcome:** a staging stack that the Android holder completes live + offline issuance and verification against over TLS, plus `12id/5-phase-1-findings.md` and updates to 4-init §10/§12.

## Decisions (this session)
| Item | Decision | Consequence |
|---|---|---|
| Hosting | One cloud Linux VM + Docker Compose, Caddy for TLS | Provider-agnostic; no Kubernetes in Phase 1 |
| Ledger topology §12.1 | **Deferred** — von-network on the staging VM | Everything is driven by a genesis URL, so moving to a third-party network or our own validators later is a config swap, not a rebuild |
| Mediator line §12.8 | **Pinned 0.6 image `mediator:375518d`** | The DIDDoc-context fork change in the holders becomes permanent (§2.7.4). Revisit when upstream publishes a 0.7 image |
| Corporate Wi-Fi §12.9 | No access soon | Build the `indy-vdr-proxy` hedge proactively; record it as an accepted open risk |
| Revocation | Out (unchanged) | No tails server |

**Staging VM (verified 2026-09-13 over SSH):**

| Item | Value |
|---|---|
| Host | `id-dev`, `123.176.58.72` |
| Domain | `12id.naziharitsolution.com` (A record → that IP, TTL 600) |
| OS / hardware | Ubuntu 24.04.3, x86_64, 4 vCPU, **16 GB RAM** (upsized from 7.8 GB), 4 GB swapfile, 88 GB free disk |
| Docker | 29.8.0, Compose v5.5.1 already installed |
| Access | `ubuntu`, key-only SSH (`~/.ssh/12id_staging_ed25519`), passwordless sudo |
| Firewall | ufw active: 22, 80, 443, Indy client 9702/9704/9706/9708 |

- **DNS:** wildcard `*.12id.naziharitsolution.com A 123.176.58.72` is live. Services use `mediator.`, `genesis.`, `ledger.`, `vdr.`, `grafana.`, `smoke-issuer.`; Caddy issues per-host certificates via HTTP-01.
- **RAM:** upsized to 16 GB. Per-service `mem_limit`s are kept so Phase 2 agents fit the same budget.
- **W1 hardening done (2026-09-13):**
  - SSH password auth disabled (`/etc/ssh/sshd_config.d/00-12id-hardening.conf`); refusal verified from outside.
  - ufw, unattended-upgrades and fail2ban enabled. fail2ban logged 82 failed SSH logins within minutes, so the VM was already being brute-forced.
  - **Still to do by the owner:** rotate the `ubuntu` password (it was shared in chat).
- **Ports:** 80/443 not yet verified from outside; nothing listens until Caddy is up.
- **Docker bypasses ufw.** von-network publishes 9000 and the node-to-node ports 9701/9703/9705/9707 on all interfaces. They must be bound to localhost or dropped in the `DOCKER-USER` chain (W2).
- **von-network `/register` is unauthenticated** and can write ENDORSER NYMs. It must never be public; Caddy blocks it and bootstrap uses `127.0.0.1:9000` on the VM.
- **Pre-existing issue:** a HashiCorp apt repo on the VM has a missing GPG key. Left untouched.
- **Ops email** (ACME/alerts): `onetwoidadmin@gmail.com`. The Android device is needed again for W8.

## Layout
`infra/` lives inside this repo (`12id/infra/`, remote `nazihar/12id`). A `.gitignore` excludes decrypted secrets and keys; only `*.sops.*` secret files may be committed:
```
infra/
  staging/
    compose.ledger.yml      von-network (vendored/pinned) + genesis snapshot
    compose.mediator.yml    postgres, valkey, migrate, mediator x2, webhook-sink
    compose.edge.yml        caddy, indy-vdr-proxy
    compose.monitoring.yml  prometheus, grafana, alertmanager, exporters, indy-node-monitor
    Caddyfile
    secrets/*.sops.env      SOPS+age encrypted
    init.sql                from phase0/mediator/init.sql
  scripts/
    deploy.sh               sops decrypt -> compose up, per stack
    check-mediator-tables.sh
  ledger/
    bootstrap-endorser.ts   from phase0/agent/src/s2-ledger.ts + bootstrap.ts
  smoke/                    parameterised copies of the phase0 scenario scripts
  runbooks/                 genesis rotation, TAA acceptance, secrets, backup/restore
```

## Workstreams

### W1 — VM baseline
- **First:** install an ed25519 SSH key for `ubuntu`, confirm key login, then set `PasswordAuthentication no` and restart sshd (keep the current session open until key login is re-verified). Ask the user to rotate the `ubuntu` password.
- Harden: enable ufw (default deny incoming; allow 22/80/443 + Indy client ports), unattended upgrades, fail2ban. Docker + compose are already installed.
- Put Docker-published ports behind ufw correctly: Docker bypasses ufw via iptables, so bind internal services (postgres, redis, grafana, node ports) to `127.0.0.1` or internal networks only.
- Verify 80/443 reachable from outside once Caddy listens (rules out a provider firewall).
- **Pre-flight:** confirm the VM reports ~16 GB (`free -h`) and that the wildcard resolves (`dig +short mediator.12id.naziharitsolution.com` → `123.176.58.72`) before starting.
- **Memory budget** (sized to fit the old 7.8 GB, kept as limits on the 16 GB VM — the remainder is headroom for Phase 2): set `mem_limit` on every service. Rough allocation:

  | Service | Limit |
  |---|---|
  | von-network, 4 nodes + web | ~2.5 GB |
  | Mediator × 2 | 512 MB each (the README's `max-old-space-size=512`) |
  | Postgres | 1 GB |
  | Valkey | 256 MB |
  | Caddy + vdr-proxy | 256 MB |
  | Monitoring (Prometheus with 7-day retention, Grafana, exporters) | ~1.2 GB |
  | Smoke issuer | 512 MB |

  Add a 4 GB swapfile as a safety net and watch for OOM kills in W7.
- Cloud firewall: open 80 and 443, plus Indy **client** ports 9702/9704/9706/9708. Node-to-node ports 9701/…/9707 are blocked externally.
- DNS: `mediator.`, `genesis.`, `ledger.` (browser), `vdr.` (proxy), `grafana.`, `smoke-issuer.`.
- Caddy with automatic Let's Encrypt; WebSocket upgrade proxied to the mediator.

### W2 — Ledger + genesis distribution
- von-network started with the VM's **public IP** (`./manage start <public-ip>` — the 4-init §2.1 trap). Pin von-network to a commit.
- Genesis snapshot served by Caddy as static files: `https://genesis.<domain>/v1/pool_transactions_genesis`, plus `.sha256` and a detached ed25519 (minisign) signature.
  - Cache headers: long max-age on the versioned path, short on a `current` pointer.
  - SDK-side verification of the signature is a Phase 5 item; Phase 1 publishes the signature and documents it.
- `runbooks/genesis-rotation.md`: how a new version is cut when validators change.

### W3 — Trustee / Endorser DIDs
- `infra/ledger/bootstrap-endorser.ts`, reusing `phase0/agent/src/bindings.ts` (import order), `agent.ts`, `bootstrap.ts` and `logger.ts`.
  - Generate the endorser key **inside an Askar store**.
  - Register `{did, verkey, role: ENDORSER}` via von-network's `/register`, which writes with its built-in trustee.
  - The private key never leaves the store.
- Store: Askar on Postgres. This is a first test of Postgres-backed Askar (currently "not yet tested"), on a dedicated database.
- `runbooks/taa.md`: TAA acceptance flow for networks that have one, via Credo `IndyVdrModule` config. Documented only — von-network has no TAA; mark it not run.

### W4 — Mediator deployment
Based on `phase0/mediator/docker-compose.yml`; every §2.3 setting carries over.

**Configuration**
- `AGENT_PORT=3000`
- `AGENT_ENDPOINTS=wss://mediator.<domain>,https://mediator.<domain>` — wss first
- `MESSAGE_PICKUP__FORWARDING_STRATEGY=QueueAndLiveModeDelivery`
- Pickup-storage host without a port
- Three databases via `init.sql`
- `CREATE_NEW_INVITATION=false` (stable invitation across restarts)

**Migration**
- Same command as Phase 0, with `--database-url`.
- Followed by `check-mediator-tables.sh`: fail the deploy if `StorageVersion` etc. are missing, since exit code 0 proves nothing.
- Pre-bake pnpm: a thin `FROM mediator:375518d` image that runs `corepack prepare`, so the migration needs no npm registry access at runtime.

**Multi-instance and webhook**
- Two mediator replicas behind Caddy.
- `CACHE__TYPE=redis`, `MESSAGE_PICKUP__MULTI_INSTANCE_DELIVERY__TYPE=redis`.
- `webhook-sink`: a tiny container that logs every POST with a timestamp.
- `PUSH_NOTIFICATIONS__WEBHOOK_URL` points at it over the internal Docker network only.

### W5 — Mediator verification matrix (the Phase 1 evidence)
Record results in `5-phase-1-findings.md`.

| # | Test | Expected (source-read basis) |
|---|---|---|
| M1 | TLS: Credo holder mediation + round trip over `wss` | Works as in S5 |
| M2 | Webhook, single instance, no Firebase block | **Never fires** (`pushNotificationLoader.ts:10`) |
| M3 | Webhook, single instance, `PUSH_NOTIFICATIONS__FIREBASE__PROJECTS='[]'` + title/body | Fires per queued message: `sendNotification.ts` POSTs the webhook before its Firebase check, and FCM is skipped because no token record exists. If zod rejects an empty array, record that |
| M4 | Webhook, multi-instance redis | Fires per queued message with no Firebase gate (`redisMessageDeliveryLoader.ts`) |
| M5 | Multi-instance: holder socket on replica A, forward lands on replica B | Delivered on next `PickUpV1` poll (shared Postgres queue) |
| M6 | Kill one replica with messages queued | Messages survive; holder reconnects and collects them |

Pin the resulting mode: expected **multi-instance redis**, since it gives both HA and a webhook without the Firebase workaround.

### W6 — Mediator abuse controls (Phase 1 portion of §2.3)
- **Rate limiting** at the edge: per-IP limits on WS upgrades and POSTs. Needs a Caddy build with the `caddy-ratelimit` module (xcaddy); pin that image.
- **Never expose the startup invitation.** It only appears in logs; ship logs to a restricted location.
- **Alerting** on mediation-record creation rate via a postgres_exporter custom query (see W7).
- **Design note** (not built): per-user invitation gating is Phase 3 (`GET /mediator/invitation`).
  - Record the constraint: issuers must reach the same endpoint unauthenticated to forward, and payloads are encrypted, so a proxy cannot tell a mediation request from a forward.
  - Gating therefore needs a mediator-side hook or a patch.
  - Output: the options and a recommendation, for Phase 3.

### W7 — Monitoring and alerting
- **Stack:** Prometheus + Alertmanager + Grafana (behind Caddy auth + IP allowlist), node_exporter, cAdvisor, postgres_exporter.
- **Custom queries:** pickup queue depth (`message_pickup` db), mediation record count/rate.
- **blackbox_exporter probes:** genesis HTTPS, mediator `wss` handshake, the 4 Indy client ports, TLS certificate expiry.
- **`indy-node-monitor`** against von-network's pool (uses the pool's steward/trustee seed; dev only). Import its Grafana dashboards.
- **Alerts:** validator down / pool below consensus (<3 of 4), queue depth growing for more than N minutes, mediation-record spike, certificate expiring in under 14 days, disk above 80%, container restart loops.

### W8 — Staging smoke tests (reuse the Phase 0 scenarios)
- Copy `phase0/agent/src` scenarios into `infra/smoke/`.
  - Replace `HOST_IP` string-building (`config.ts`, `s5-mediated.ts:28`, `s7-android-offline.ts:22`) with explicit `LEDGER_URL`, `GENESIS_URL`, `MEDIATOR_INVITATION_URL`, `ISSUER_ENDPOINT` env vars.
  - The existing `MEDIATOR_INVITATION_URL` / `PICKUP_STRATEGY` / `INDY_NAMESPACE` handling stays.
- **Smoke issuer** runs as a container on the VM at `https://smoke-issuer.<domain>`, reachable from the phone. This replaces the Phase 0 `adb reverse` workaround.
- **`smoke:credo`** — s5 scenario with the Credo holder on `PickUpV2LiveMode` (the Credo holder cannot do ws-first `PickUpV1`, per findings). Must end `isVerified: true`, v1 only.
- **`smoke:android`** — the `s7-android-offline.ts` scenario against staging.
  - App repointed at the https genesis and the wss mediator invitation.
  - Confirms the Kotlin WS transport handles `wss`.
  - Live, offline and proof must all be DONE.
- **Wire logger** (`wire-log.ts`) enabled in both.

### W9 — Secrets
- **SOPS + age.** Encrypted env files live in the repo; the age private key exists only on the VM and in the operator's password manager. `deploy.sh` decrypts to tmpfs, runs `compose up`, then removes the decrypted files.
- **What goes in SOPS:** Postgres passwords, Askar store keys (mediator, endorser store), Grafana admin, minisign secret key.
- **Endorser private key** stays inside Askar and is never exported; only its store key is a secret.
- **Backups:** nightly encrypted `pg_dump` of all databases to object storage. `runbooks/backup-restore.md` includes one restore drill.

### W10 — `indy-vdr-proxy` hedge (§4.6, §12.9)
- **Deploy** `indy-vdr-proxy` built from a pinned `hyperledger/indy-vdr` tag, fed our genesis, at `https://vdr.<domain>`. Verify schema and cred-def reads with curl.
- **Feasibility assessment** (source read, no fork change built in Phase 1):
  - The Kotlin holder opens a direct TCP pool: `openPool(genesisPath, null, null)` at `ariesframework/.../ledger/LedgerService.kt:60`. Its reads sit around `LedgerService.kt:340-355`.
  - Name the exact methods that would need an HTTP path.
  - Estimate effort.
  - Analyse trust: a proxy response is only as trustworthy as our proxy, unless state proofs are verified on device.
- **Record** §12.9 as an accepted open risk with this assessment attached. The TCP probe script from S8 stays ready for when corporate access appears.

## Out of scope for Phase 1
Production ledger / validator hosting (§12.1 deferred), Platform API and per-user invitation endpoint (Phase 3), Postgres agent wallets for issuer/verifier and tenants (Phase 2 — only the endorser store is tested here), Swift pass, holder SDK work.

## Suggested order
W1 → W2 → W3 → W9 (secrets before real deploys) → W4 → W8 `smoke:credo` over TLS (M1) → W5 → W8 `smoke:android` → W6 → W7 → W10. W10 can run in parallel from W2 onward.

## Verification
- `compose ps` all healthy on every stack.
- `curl https://genesis.<domain>/v1/...` returns 4 validator entries; sha256 and minisign signature verify.
- TCP connect to the 4 client ports from outside the VM succeeds; node ports refused.
- Endorser NYM visible with role ENDORSER in the ledger browser.
- `check-mediator-tables.sh` passes after migration; the mediator log shows the ws-first endpoints and `QueueAndLiveModeDelivery`.
- M1–M6 each recorded with log excerpts (webhook-sink timestamps for M2–M4).
- `smoke:credo` and `smoke:android` green over TLS; wire log shows only `did:sov:…;spec/…` v1 types.
- Each alert rule fired once deliberately (stop a validator, stop a mediator replica, fill the queue) and seen in Alertmanager.
- Backup restored into a scratch Postgres and the mediator started against it.
- `curl https://vdr.<domain>/...` returns the published schema; W10 assessment written.

## Document updates this produces
- `12id/5-phase-1-findings.md`: evidence for W5, W8, W10.
- `12id/4-init-post-phase-0.md`:
  - Tick §10 Phase 1 items.
  - §12.8 → decided (a).
  - §12.1 → deferred, with von-network staging.
  - §12.9 → accepted risk + proxy assessment.
  - §2.3 webhook rows updated from "not yet tested" to results.
  - Mark TLS / multi-instance / Postgres-Askar confirmed or not.
