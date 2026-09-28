# Phase 1 — Findings

**Status:**

| Workstream | State |
|---|---|
| W1 VM baseline | **done** |
| W2 Ledger | **done:** consensus verified, signed genesis `v1` published |
| W3 Endorser DID | **done**, on Postgres-backed Askar (restore-drilled) |
| W4 Mediator | **done:** two replicas, migration fixed, pinned config (multi-instance `none` + Firebase placeholder) |
| W5 Mediator verification | **done** for M1 (TLS, Credo and native holder), M2/M3/M4 (webhooks), M5 (cross-replica). **Open:** M6 (kill a replica with messages queued) |
| W6 Abuse controls | **partial:** `/invite` blocked, per-IP rate limiting live, mediation-spike alert live. **Open:** per-user invitation gating design |
| W7 Monitoring | **done:** 14 targets, 14 rules, ledger write probe. **Open:** alert email (owner's app password), `indy-node-monitor`/dashboards, deliberately firing each alert |
| W8 Smoke tests | **done:** `smoke:credo` and `smoke:android` both PASSED over the staging edge |
| W9 Secrets and backups | **done:** SOPS+age, nightly encrypted backups, restore drill. **Open:** start a mediator against a restored database; owner backs up the age key |
| W10 Proxy hedge | **done:** proxy live on 443, reply format verified, fork change assessed (1–2 days/platform); corporate-network test still not run |
**Environment:** staging VM `id-dev`, `123.176.58.72`, `*.12id.naziharitsolution.com`, Ubuntu 24.04.3, 4 vCPU / 16 GB, Docker 29.8 / Compose v5.5.
**Plan:** [5-phase-1.md](5-phase-1.md).

Every claim below comes from a command run against the staging VM on 2026-09-13.

---

## W1 — VM baseline (done)

### Access and hardening
- **Key-only SSH.** An ed25519 key was installed for `ubuntu` and key login verified. Password auth was then disabled via `/etc/ssh/sshd_config.d/00-12id-hardening.conf`.
  - The `00-` prefix matters: Ubuntu cloud images ship `50-cloud-init.conf`, and sshd takes the first value it reads.
  - Effective config (`sshd -T`): `passwordauthentication no`, `kbdinteractiveauthentication no`, `permitrootlogin no`.
  - A password attempt from outside now gets `Permission denied (publickey)`.
- **The VM was being brute-forced long before hardening.** The ssh journal for 2026-09-13 alone shows thousands of failed logins from a handful of addresses: 2,294 from `109.160.32.91`, 1,599 from `109.160.32.33`, then 371, 223, 217…. Open-password SSH on a public IP is not survivable even for staging.
- **Enabled:** ufw (22, 80, 443, 9702/9704/9706/9708), unattended-upgrades, fail2ban, and a 4 GB swapfile.
- **Owner actions outstanding:**
  - Rotate the `ubuntu` password (it was shared in chat).
  - Back up `/opt/12id/secrets/age.key` to the password manager (W9).
- **Pre-existing state on the VM (not introduced by Phase 1; left untouched, owner to decide):**
  - the HashiCorp apt repository fails GPG verification (`NO_PUBKEY FC9CA96ACA026560`);
  - a 7-year-old `eclipse/che-ip:latest` Docker image is present.

  Both suggest the VM had prior use. A rebuild from a clean image would be the safer base for production.
- **The downlink caps at about 1 MB/s (~8 Mbit/s), independent of source.** 10-second samples:

  | Source | Rate |
  |---|---|
  | Debian mirror | 1.02 MB/s |
  | GitHub releases | 0.98 MB/s |
  | Two concurrent image pulls, combined on `ens3` | ~1.3 MiB/s |

  The mediator image's largest layer (157 MiB) slowed to about 85 KiB/s near its end. First deploys of large images (the `node:22`-based mediator) take tens of minutes. Pre-pull or mirror images before any time-boxed test, and never schedule a Rust toolchain build (W10) alongside a large pull.
- **Intermittent DNS failures from one upstream.** systemd-resolved is configured (DHCP) with `10.1.1.1 8.8.8.8 1.1.1.1`, and its current server was `8.8.8.8`.
  - A direct `dig ghcr.io @8.8.8.8` **timed out**; `@1.1.1.1` answered.
  - One `curl` to `ghcr.io` failed with `Could not resolve host` during the image pull.
  - 100 follow-up lookups across 5 registry/mirror hosts all succeeded.

  Likely cause: a query landing on the unreachable upstream before resolved fails over. Not blocking; the option is a resolved drop-in that removes `8.8.8.8`, which overrides provider DHCP and is therefore left to the owner. A failed pull with a DNS error on this VM should be retried, not debugged as a registry problem.
- **BuildKit session warnings during `docker compose build`.** dockerd logs `session healthcheck failed fatally ... only one connection allowed`. The builds themselves succeeded (ledger-tools), so this is treated as noise unless a build actually fails.

### Network facts
| Fact | Evidence | Consequence |
|---|---|---|
| The VM is behind **1:1 NAT** | `ens3` has `10.1.1.71/24`; default route via `10.1.1.1`; the public IP is not on any interface | Services bind the private interface / `0.0.0.0` while advertising the public IP |
| **Hairpin NAT works, and rewrites the source to the gateway** | TCP to `123.176.58.72` succeeds from the host and from containers. tcpdump on `ens3` shows hairpinned SYNs to the node ports arriving **from `10.1.1.1`** | Firewall allow-rules for hairpin traffic must match `10.1.1.1`, not the VM's own addresses |
| **Internet traffic keeps its real source IP** | Failed SSH logins are logged from real public addresses; none from `10.1.1.1` | Allowing `10.1.1.1` does not open a port to the internet |
| **No provider firewall** | Temporary listeners on 80, 443 and 9702 were all reachable from outside (HTTP 200) | ufw is the only packet filter, so Docker's ufw bypass is a real exposure |
| **No global IPv6** | `ip -6 addr show scope global` is empty | `[::]` port publications are not internet-reachable today; revisit if IPv6 is added |

### Trap: Docker-published ports bypass ufw
von-network's compose file publishes its web server and all eight node ports on `0.0.0.0`. The web server exposes the unauthenticated `/register` endpoint, which writes NYMs with any role. With no provider firewall, ufw rules alone would have left:
- the ledger's write path open to the internet;
- the node-to-node consensus ports open to the internet.

Fixes:
- **Web server:** bound to `127.0.0.1:9000` via von-network's `.env` (`WEB_SERVER_HOST_PORT=127.0.0.1:9000`; `manage` loads `.env`).
- **Node-to-node ports** (9701/9703/9705/9707): these cannot be bound to localhost, because hairpin traffic arrives on `ens3`. They are dropped in the `DOCKER-USER` chain unless the source is `10.1.1.1` (`infra/staging/ufw/after.rules.docker-user`, appended to `/etc/ufw/after.rules`). The match uses `--ctorigdstport`, so the rule survives Docker's DNAT.

### Trap: the first firewall rule broke consensus silently
The first version allowed hairpin traffic from the VM's private (`10.1.1.71`) and public (`123.176.58.72`) addresses. It looked fine:
- the web server reported `ready: true`;
- the ledger browser rendered;
- the genesis read worked;
- the node ports were blocked from outside.

But **every write failed**:
```
POST /register -> 500
indy_vdr.error.VdrError: Pool timeout
server.anchor.AnchorException: Error submitting ledger transaction request
Node2: primary has been disconnected for too long ... view change will not be proposed now
```
`DOCKER-USER` counters showed **0 packets** on both allow rules and **66 on each drop rule**, i.e. the nodes' own consensus traffic was being dropped. Reads keep working because the client ports were never filtered.

Replacing the allow list with `10.1.1.1` fixed it; the next write succeeded on the first attempt. **Lesson for W7:** a "ledger ready" probe is not a consensus probe. Monitoring must include a periodic write, or at least node-connectivity metrics from `indy-node-monitor`.

Verified from outside after the fix:
```
node port 9701 blocked    client port 9702 open
node port 9703 blocked    client port 9708 open
node port 9705 blocked
node port 9707 blocked    (9000 blocked, verified earlier)
```

### Edge / TLS
- **Caddy 2.11.4** runs with host networking (`infra/staging/compose.edge.yml`) and obtained Let's Encrypt certificates for `ledger.`, `genesis.` and `mediator.` on first start (HTTP-01).
- `curl` from outside verifies all three chains (`ssl_verify_result=0`).
- `POST https://ledger.…/register` returns **403**: Caddy refuses it publicly, and bootstrap uses `127.0.0.1:9000` on the VM.
- Internet scanners (e.g. LeakIX) were crawling the ledger browser within minutes of the certificate being issued, via Certificate Transparency. Anything behind a new hostname is public immediately.

---

## W2 — Ledger

- **von-network** pinned at `0885f85f70ae3a1bba8512895c48bebafd50c03a` (2026-04-17). The `von-network-base` image built in 255 s (723 MB).
- **Started with `./manage start 123.176.58.72`.** All four validators advertise `client_ip 123.176.58.72` on ports 9702/9704/9706/9708.
- **Consensus verified with a real write:** throwaway role-less NYM `DNUHdYExTmB6dpfj9VoSVs` registered through `127.0.0.1:9000/register`.
- **Ledger browser** is served at `https://ledger.12id.naziharitsolution.com/` (HTTP 200).
- **Genesis publication** is done by `infra/scripts/snapshot-genesis.sh`. It refuses a genesis with the wrong validator count, or one advertising a private or Docker-internal address (the 4-init §2.1 `host.docker.internal` trap). Published versions are immutable.
- **Signed genesis `v1` published** (sha256 `6ab9bc1a3ba5ff257454ca8500a41d45756cd02c3db6c280bde51c7b363a835a`, 3,099 bytes, 4 validators). Verified from outside over HTTPS:

  | Check | Result |
  |---|---|
  | `sha256sum -c` against the published `.sha256` | OK |
  | `/v1/` `Cache-Control` | `public, max-age=31536000, immutable` |
  | `/current/` `Cache-Control` | `public, max-age=300`; content identical to `v1` |
  | Directory listing at `/` | 404 |
  | `minisign -V` of the publicly fetched file against the committed key (`infra/staging/genesis-signing.pub`) | `Signature and comment signature verified`, trusted comment `12id genesis v1 2026-09-13T06:21:17Z` |

  URL for agents and the SDK: `https://genesis.12id.naziharitsolution.com/v1/pool_transactions_genesis`.

---

## W9 — Secrets (in place)

- **Tools on the VM:**
  - `age` 1.1.1 and `minisign` 0.11 from apt.
  - `sops` 3.13.3 installed as the checksum-verified static binary.
- **Trap:** sops' release checksum file covers only the standalone binaries, not the `.deb` published alongside them. A script that downloads the `.deb` and greps the checksums file finds nothing to verify. Use `sops-vX.Y.Z.linux.amd64`.
- **Keys** live on the VM in `/opt/12id/secrets/` (mode 700, files 600):
  - age key, recipient `age1ftkynx64…0lc5q`;
  - minisign key `169255404DD823AD`, whose public key is committed at `infra/staging/genesis-signing.pub`.
- **Encrypted secret files** are generated on the VM, encrypted there, and pulled into the repo. Plaintext existed only in `/dev/shm` and was shredded.

  | File | Contents |
  |---|---|
  | `mediator.sops.env` | `POSTGRES_PASSWORD`, `MEDIATOR_ASKAR_STORE_KEY` |
  | `ledger.sops.env` | `ENDORSER_ASKAR_STORE_KEY` |
  | `monitoring.sops.env` | `GRAFANA_ADMIN_PASSWORD` |
  | `genesis.sops.env` | `MINISIGN_SECRET_KEY_B64` |

  Local check: every value line is `ENC[…]`, with no plaintext lines.
- **`.sops.yaml`** scopes encryption to `infra/staging/secrets/*.sops.*`. `.gitignore` excludes every other env/key file.
- **`infra/scripts/deploy.sh <stack>`** decrypts `secrets/<stack>.sops.env` into `/dev/shm` for `docker compose --env-file` and shreds it on exit.
- **Single point of loss:** the age private key exists only on the VM until the owner backs it up. Losing the VM without that backup makes every `*.sops.env` in the repo unrecoverable.

### Backups and restore drill (done)
Decision (owner): **VM-local backups** for staging, 7-day rotation. `infra/scripts/backup-postgres.sh` runs from `12id-backup.timer` (nightly 02:30 UTC, `Persistent=true`).

First manual run, `20260913T070457Z`:

| File | Size |
|---|---|
| `drizzle.dump.age` | 61,866 B |
| `endorser.dump.age` | 14,289 B |
| `mediator.dump.age` | 14,146 B |
| `message_pickup.dump.age` | 9,769 B |
| `globals.sql.age` | 871 B |

- `sha256sum -c SHA256SUMS` OK for all five files.
- Every file starts `age-encryption.org/v1`: `pg_dump` is piped straight into `age`, so no plaintext dump exists on disk.
- The timer is scheduled (`NEXT Mon 2026-09-14 02:30:54 UTC`).

**Restore drill** (`runbooks/backup-restore.md`) into a scratch `postgres:15-alpine` on an isolated network:
- `pg_restore --create` succeeded for `drizzle`, `message_pickup`, `mediator` and `endorser`.
- Content present: `drizzle."StorageVersion"` has 1 row, and `message_pickup.queued_message` has 4 rows (leftover messages for shut-down smoke holders).
- **The restored endorser Askar store opened with the real store key**, with the scratch database aliased onto `12id-mediator`: `Askar store 'endorser' already exists` → `result: existing`, DID `did:indy:twelveid:staging:9WnSruRkr6b3V7XX9zPjka`, exit 0. That proves the backup captures a usable key store, not just tables.
- Drill resources removed afterwards.

**Limits:** VM loss still loses backups, the age key and the sops-decryptable secrets together (accepted for staging). The drill did not start a mediator against the restored databases; the plan's verification line asks for that, and it remains open.

> **Phase 7 update (2026-09-22, review H3):**
> - `endorser.dump.age` is no longer produced from this instance. The store is dumped from `agent-postgres` as `agent-endorser.dump.age`.
> - Both instances' `--globals-only` dumps now carry the per-service roles.
> - A restore drill of an Askar store must connect as a role named like the store's schema (trap 49). The endorser drill passed that way on 2026-09-22.
> - See [`17-phase-7.md`](17-phase-7.md) H3 and [`infra/runbooks/postgres-roles.md`](../infra/runbooks/postgres-roles.md).
> - The limits above are unchanged (review M13, kept open).

---

## W4 — Mediator (in progress)

### Trap: the mediator serves its invitation over plain HTTP, unauthenticated
`apps/mediator/src/agent.ts` (image `375518d`) registers two Express routes on the agent port, alongside DIDComm:

| Route | Behaviour |
|---|---|
| `GET /health` | Returns **202** (not 200). Health checks that expect 200 mark the mediator down forever |
| `GET /invite?_oobid=<id>` | Returns the full out-of-band invitation JSON for any OOB record in `await-response` state. **No authentication** |

The `_oobid` travels inside the invitation URL, so anyone who has seen that URL can fetch the invitation through the public hostname. That compounds the open-mediation gap (§2.3).

A reverse proxy that forwards every path, which is the natural default for a DIDComm endpoint, publishes this route. The staging Caddyfile answers `/invite` with 404 on `mediator.12id…`; tooling that needs the invitation reads it on the VM via `127.0.0.1:3001/invite`. Active Caddy health checks and the container healthchecks both target `/health` expecting 202.

**For Phase 3:** the per-user invitation endpoint (`GET /mediator/invitation`) must be the only way invitations leave the platform, and the mediator's own `/invite` must stay unreachable from outside.

> **Phase 7 update (2026-09-22, review M18):** the Drizzle migration creates no secondary indexes.
> - drizzle-storage also wrote every array/jsonb lookup as an unindexable `to_jsonb(…) @> …`, so each inbound message scanned `Did` in full.
> - Image `-p4` patches the query builder, and `infra/staging/mediator/indexes.sql` adds 14 indexes through the one-shot `mediator-indexes` service.
> - At 10,000 wallets the per-message lookup went from 12 ms to 0.09 ms.
> - See [`17-phase-7.md`](17-phase-7.md) M18.

### Pre-baked migration image
`infra/staging/mediator/Dockerfile.migrate` extends `mediator:375518d`:
- installs pnpm 10.7.0 and 10.24.0 into a shared `COREPACK_HOME`;
- sets `COREPACK_ENABLE_NETWORK=0`;
- runs `pnpm --version` from `apps/mediator` during the build.

A migration that would need the npm registry therefore fails at build time instead of at deploy time. The image runs as `agent` (uid 1001, home `/nonexistent`), which is why pnpm is installed as root into a shared directory rather than the user cache.

### Trap: the documented migration command is a no-op under Compose
4-init §7.3 documents the migration container as:
```yaml
entrypoint: ["sh", "-c"]
command: cd /app/apps/mediator && pnpm run drizzle:migrate:postgres --database-url "$$STORAGE__DATABASE_URL"
```
With a **string** `command:`, Compose splits the string into words before handing it to the entrypoint. Observed on staging (Compose v5.5.1):

| Evidence | Value |
|---|---|
| `docker inspect` | `Entrypoint=["sh","-c"]`, **`Cmd=["cd","/app/apps/mediator"]`** |
| Migrate container | **exit 0**, no log output |
| `check-mediator-tables.sh` | `MISSING drizzle.StorageVersion`, `MISSING drizzle.PushNotificationsFcm` |
| Both mediator replicas | crash-looping (`restarts=9`, unhealthy) on `parserOpenTable`, i.e. a missing table |

`sh -c` ran the script `cd` and nothing else. The fix is a **one-element list**, so the whole string reaches `sh -c`:
```yaml
command: ['cd /app/apps/mediator && pnpm run drizzle:migrate:postgres --database-url "$$STORAGE__DATABASE_URL"']
```

**This likely re-explains a Phase 0 finding.** Phase 0 recorded "the migration silently no-ops without `--database-url`", then used the same string form. Exit 0 with no output and no tables is exactly this symptom. The `--database-url` requirement may still be real, but it was never isolated. 4-init §7.3 should be corrected to the list form either way.

**The table check paid for itself on its first run.** Without it, the only signal was two crash-looping containers and a 503 at the edge.

### Trap: a deploy script that reports on a stack still starting
The first staging deploy piped `compose up` through `tail`, which discards compose's exit code, and ran the outside checks immediately. The result was `503` on `/health` while the containers were seconds old and before the migration problem above was visible. Deploy verification must wait for container health with a deadline, and must fail loudly, before probing the edge.

### Result: mediator stack healthy (after the migration fix)
| Check | Result |
|---|---|
| Migrate container | `Cmd=["cd /app/apps/mediator && pnpm run drizzle:migrate:postgres --database-url \"$STORAGE__DATABASE_URL\""]`, exit 0, `Migrated bundle didcomm` / `./build/drizzle/bundle.js`, `Applying migrations completed successfully!` (three bundles: core, didcomm, mediator) |
| `check-mediator-tables.sh` | `ok drizzle.StorageVersion`, `ok drizzle.PushNotificationsFcm` |
| `check-mediator-tables.sh --after-start` | also `ok message_pickup.queued_message`, `ok message_pickup.live_session` |
| Replicas | `mediator-1` and `mediator-2` healthy on `127.0.0.1:3001/3002`; stack RAM 1.3 GiB used of 15 GiB |
| From outside | `GET /health` → **202**; `GET /invite?_oobid=…` → **404** (blocked at the edge); WebSocket upgrade → **101**; 3001/3002/5432/6379 not reachable |

### Trap: two mediator replicas race when provisioning the Askar store
On a simultaneous start, one replica logged:
```
Error creating store 'mediator' ... Error creating database tables
Caused by: error returned from database: duplicate key value violates unique constraint 'pg_namespace_nspname_index'
Error provisioning store { name: 'AskarStoreError' ... }
```
Both replicas ran `provisionStore` against the same Postgres at once and raced on `CREATE SCHEMA`. The mediator catches provisioning errors (`apps/mediator/src/agent.ts`), so the loser carried on and both became healthy. That is luck, not design: a race that lands between creating tables and writing the store key could leave a half-provisioned store.

**Fix applied:** `mediator-2` now `depends_on: mediator-1: service_healthy`, so only one replica provisions on a fresh database. For Phase 6 multi-instance work: any horizontally scaled Credo service sharing one Askar Postgres store needs a single provisioning step (an init job or a staggered first start), not N concurrent provisions.

---

## W3 — Endorser DID (done)

Tool: `infra/ledger/`, a small Credo 0.7 project run as a one-off container (`compose.ledger.yml`, service `bootstrap-endorser`). It joins von-network's Docker network to reach `/register` and the mediator network to reach Postgres. It fetches the public signed genesis and checks its sha256 before connecting.

> **Phase 7 update (2026-09-22, review H3):**
> - The `endorser` Askar store described here was moved off the mediator's Postgres, by dump and restore. It is now on `agent-postgres`, owned by the `endorser_service` role, and no other role may connect to it.
> - The mediator instance's copy is kept until 2026-09-29, then dropped.
> - **Trap 49:** Askar keeps its tables in schema `"$user"`, so changing a store's DB user needs `pg-roles.sh askar-schema-*`.
> - Evidence: [`infra/runbooks/postgres-roles.md`](../infra/runbooks/postgres-roles.md). See [`17-phase-7.md`](17-phase-7.md) H3.

Image `12id/ledger-tools:credo-0.7.0` (`node:22.20.0-bookworm-slim`, `npm ci --omit=dev` from a committed lockfile) builds in 166 s and is 603 MB. All three native bindings (`askar`, `indyVdr`, `anoncreds`) load inside it under plain Node type stripping.

Found while building it:
- **`did:indy` namespaces must start with a lowercase letter.** Credo's `didIndyRegex` is `^did:indy:((?:[a-z][_a-z0-9-]*)(?::[a-z][_a-z0-9-]*)?):…`. A namespace like `12id` is rejected, and so is anything with more than one `:` sub-namespace. Staging uses `twelveid:staging`. This choice ends up inside every DID and qualified identifier the platform issues, so it deserves a deliberate decision before production.
- **Askar on Postgres (Credo 0.7)** is `store.database = { type: 'postgres', config: { host: 'host:port', connectTimeout? }, credentials: { account, password, adminAccount?, adminPassword? } }`.
  - The store id doubles as the database name.
  - Provision explicitly with `agent.modules.askar.provisionStore()`, tolerating `AskarStoreDuplicateError`, as the mediator does.
- **Type-check Credo code; do not rely on Node's type stripping.** Phase 0's agent factory passed `config.label`, which is not an `InitConfig` property in Credo 0.7. Strip-only execution ignores types, so the option was dropped silently. `tsc --noEmit` catches it. Phase 2 should run `tsc --noEmit` in CI even if it deploys `.ts` sources directly.

### Result: staging endorser created; Askar on Postgres confirmed
Two consecutive runs of `EXTRA_SECRETS=mediator deploy.sh ledger run --rm bootstrap-endorser`:

| Run | Store | Result | Exit |
|---|---|---|---|
| 1 | `provisioned Askar store 'endorser' on postgres` | `created` | 0 |
| 2 | `Askar store 'endorser' already exists` | `existing` (same DID, no second endorser) | 0 |

```json
{
  "did": "did:indy:twelveid:staging:9WnSruRkr6b3V7XX9zPjka",
  "nym": "9WnSruRkr6b3V7XX9zPjka",
  "verkey": "5e8ULv1YQkjc5M2zxtJEp5ztaimWCdoy4Xvdc69aznZF",
  "role": "ENDORSER",
  "indyNamespace": "twelveid:staging",
  "askarStoreId": "endorser"
}
```
Each run checks, via `GET_NYM` through `IndyVdrPoolService`, that the ledger holds role `101` (ENDORSER) with the stored verkey, and that the DID resolves through `IndyVdrIndyDidResolver`.

- **Askar on Postgres now confirmed (Tier: confirmed, run).** Provisioning, key creation in the KMS, DID import and reopening an existing store all work on the Credo 0.7 / `askar-nodejs` 0.6.0 matrix. This was "not yet tested" in 4-init §0.1.
- **Benign noise on reuse.** On the second run Askar logs `[error] Error occurred during transaction, rollback {"error":{"code":3}}` immediately before `AskarStoreDuplicateError` is caught. It is the duplicate-provision attempt, not a failure. Alerting on `[error]` lines from agents will need to know this.
- **The private key never left the store.** The NYM was written from `{did, verkey}`; no seed exists anywhere.
- **Keep in mind for Phase 2:** this endorser was written by von-network's built-in trustee via `/register`. On a real network the NYM is written by a trustee or steward, and the TAA may apply (`runbooks/taa.md`, to be written).

---

## W10 — `indy-vdr-proxy` hedge (in progress)

### Upstream facts (checked 2026-09-13)
- **The repository moved.** `hyperledger/indy-vdr` answers `301`; the project is now **`hyperledger-indy/indy-vdr`**. The latest release is **v0.4.5** (2026-02-22), after v0.4.4 (2025-11-21).
- **No proxy binary and no image are published.** Release assets contain no `indy-vdr-proxy` artefact, and the repository has no Dockerfile for it (only dev-container, coverage and test images). It has to be built from source: crate `indy-vdr-proxy` 0.1.6, `rust-version = 1.85`.
- **CLI** (`src/app.rs`):

  | Option | Meaning |
  |---|---|
  | `-g/--genesis` | Path, or URL with the default `fetch` feature |
  | `-n/--name` | Namespace, for DID resolution |
  | `--host` | Listen address, default `0.0.0.0` |
  | `-p/--port` | Listen port |
  | `--no-refresh`, `-r/--refresh-interval` | Default 120 min |
  | `--tls-cert`/`--tls-key` | Only with the `tls` feature |
  | `--use-cache` and cache size/path | Response cache |

- **HTTP routes** (`src/handlers.rs`):

  | Method | Routes | Purpose |
  |---|---|---|
  | GET | `/` | Pool status |
  | GET | `/genesis`, `/taa`, `/aml` | Pool metadata |
  | GET | `/nym/…`, `/attrib/…`, `/schema/…`, `/cred_def/…`, `/rev_reg_def/…`, `/rev_reg/…`, `/rev_reg_delta/…`, `/txn/…`, `/auth/…` | Ledger reads |
  | GET | `/1.0/identifiers/<did>` | DID resolver |
  | POST | `/submit` | **Relays signed write transactions to the ledger** |

### Staging deployment design
- **Build:** `infra/staging/vdr-proxy/Dockerfile` builds the pinned tag on `rust:1.98.1-bookworm` into a `debian:12-slim` runtime as a non-root user. There is no `--locked`, because the workspace does not pin a lockfile for the binary, so transitive crates are resolved at build time.
- **Runtime:** it runs in the edge stack with host networking on `127.0.0.1:3100`, reading the published genesis `v1` from disk.
- **Edge:** `https://vdr.12id.naziharitsolution.com` allows only **GET/HEAD**. The hedge is for holder reads; exposing `/submit` would publish a write relay to the ledger.
- **Build deferred** until the current image pulls finish: the VM's ~1 MiB/s downlink is shared, and a Rust build pulls a large toolchain image plus crates.

### Feasibility assessment: using the proxy from the Kotlin holder (source read)
Source: `phase0/android/ariesframework/src/main/java/org/hyperledger/ariesframework/ledger/LedgerService.kt`, the Phase 0 fork.

**Where ledger access happens:**
- `initialize()` opens a direct pool: `openPool(agent.agentConfig.genesisPath, null, null)` (`:60`), then refreshes it in the background (`:65–69`). Opening only parses genesis. On a network that blocks the client ports, the refresh and every request fail; initialization itself does not.
- **Every read goes through one method**, `submitReadRequest(request: Request)` (`:353–361`): `pool!!.submitRequest(request)`, then `validateResponse` checks `op == "REPLY"`.
- Callers used by a holder in v1:

  | Method | Request builder |
  |---|---|
  | `getSchema(schemaId)` (`:94`) | `buildGetSchemaRequest` |
  | `getCredentialDefinition(id)` (`:155`) | `buildGetCredDefRequest` |

  Both parse the raw ledger reply (`result.seqNo`, `result.data`, `result.tag`, `result.signature_type`, `result.ref`).
- The revocation reads (`getRevocationRegistryDefinition`, `…Delta`, `getRevocationRegistry`) are not needed in v1 (§12.3). The write methods (`registerSchema`, `registerCredentialDefinition`, `submitWriteRequest`) are issuer-side and unused by the holder SDK.

**Verdict: straightforward.** The change is confined to `submitReadRequest` plus configuration:
1. Add an optional `ledgerProxyUrl` (and a policy: proxy-only, or fall back after a direct-pool failure) to `AgentConfig`.
2. In `submitReadRequest`, when the proxy is selected, map the two v1 request types to the proxy's GET routes (`/schema/<id>`, `/cred_def/<id>`) and return the reply body. If the proxy passes the pool reply through unchanged, **no parsing code changes**.

   The alternative, POSTing the prepared request to `/submit`, needs no route mapping but means opening `/submit` at the edge, which also relays writes; rejected for now.
3. The same change is needed in the Swift framework (not yet read).

**Estimate:** about 1–2 days per platform, including configuration plumbing, fallback behaviour and a test against the staging proxy. It is not on the critical path while client ports stay reachable.

**Trust trade-off:** a direct pool read lets indy-vdr check the reply against the pool's multi-signed state. A read through the proxy trusts our TLS endpoint instead. A tampered schema or credential definition cannot produce a proof the verifier accepts, because verifiers read the ledger directly, but it can make holders fail or behave confusingly. So the proxy is an availability hedge with an integrity cost, and it must only ever be our own endpoint, pinned like the genesis URL.

**Still to verify once the proxy runs:** that `GET /schema/<id>` and `GET /cred_def/<id>` return the same reply envelope as the pool (`op`, `result.data`, `result.seqNo`, …). That determines whether step 2 needs response mapping.

### Result: proxy deployed and serving reads over 443
- **Build:** `12id/indy-vdr-proxy:v0.4.5` built from source on the VM in **1,649 s** (~27 min on 4 vCPU with the ~1 MB/s downlink); image **142 MB**. It runs in the edge stack on `127.0.0.1:3100`.
- **Pool status** from the proxy: `{"pool_nodes":["Node2","Node1","Node3","Node4"],"pool_mt_size":4,"status":"active"}`.
- **From outside, `https://vdr.12id.naziharitsolution.com`:**

  | Request | Result |
  |---|---|
  | `GET /` | 200 |
  | `GET /genesis` | 200, 3,099 bytes (same size as published genesis `v1`) |
  | `GET /nym/9WnSruRkr6b3V7XX9zPjka` | endorser, `role 101`, verkey `5e8ULv1Y…` |
  | `GET /1.0/identifiers/did:indy:twelveid:staging:9WnS…` | 200 |
  | `POST /submit` | **405** (writes blocked at the edge) |

- **Reply envelope = the pool's own reply.** `GET /nym/…` returned `{"op":"REPLY","result":{"data":"{…\"role\":\"101\"…}","dest":…,"seqNo":8,…,"state_proof":{"multi_signature":{"participants":["Node4","Node2",…`. The raw ledger reply is passed through, **including the BLS multi-signature state proof**. So, provided `GET /cred_def` behaves the same (being checked):
  - the Kotlin parsing code (`result.data`, `result.seqNo`, `result.ref`, `result.tag`) needs no changes;
  - the state proof is available for on-device verification, which narrows the trust trade-off above if the fork chooses to verify it.
- **Confirmed for credential definitions.** `GET /cred_def/Nm9wqugckgMheEe1eoHKqA:3:CL:10:default` returned `op: REPLY` with `result.data` an object and `result` keys `identifier, origin, ref, reqId, seqNo, signature_type, state_proof, tag, txnTime, type` (`ref: 10`, `tag: default`, `signature_type: CL`). Those are exactly the fields `LedgerService.getCredentialDefinition()` reads, so **the W10 fork change needs no response mapping**, only the transport switch in `submitReadRequest`. (The schema route was not called; it goes through the same pass-through handler.)
- **Monitoring picked it up:** the `vdr.` blackbox probe recovered to `probe_success=1` once the proxy was running.

---

## W8 — Smoke tests (in progress)

Tooling: `infra/ledger/src/smoke/`, run as `compose.ledger.yml` service `smoke-credo` on the VM with host networking.
- The issuer listens on `:3200` behind `https://smoke-issuer.12id…` and advertises that URL.
- Wallets are in-memory Askar with random keys.
- Genesis is the public signed `v1`, checked by sha256.
- The mediator invitation is read from the mediator logs and never printed.

### Trap: a Credo 0.7 holder cannot obtain mediation over WebSocket from a ws-first mediator
The first `smoke:credo` runs (`PickUpV2LiveMode`, then `Implicit`, both with HTTP+WS outbound) all failed identically before any ledger or credential work:
```
CredoError: Error during call to 'onInitializeContext' method in module 'didcomm'
  [cause] Timeout has occurred { meta: 'MediationRecipientApi.requestAndAwaitGrant' }
```

**What reached the edge.** The TLS edge and the handshake both work. The first two runs landed on `mediator-1`; the `Implicit` run landed on **`mediator-2`**, which shows Caddy's round-robin spreading new holder sockets across replicas, and shows the failure is not replica-specific. `Implicit` also forces WebSocket for the `mediate-request` (`transportPriority: {"schemes":["wss","ws"],"restrictive":true}`), so an HTTP-only Credo holder cannot use `Implicit` at all. Each replica logged the same sequence:
```
Received message with type 'https://didcomm.org/didexchange/1.1/request'           return_route: 'all'
Received message with type 'https://didcomm.org/didexchange/1.1/complete'          return_route: 'none'
Received message with type 'https://didcomm.org/coordinate-mediation/1.0/mediate-request'  return_route: 'all'
```

**What the holder did** (debug log, abridged):
```
Sending outbound message to endpoint 'wss://mediator.12id.naziharitsolution.com' over WebSocket transport.   (request)
Connecting to WebSocket wss://mediator... / Successfully connected
Payload received from mediator ... Connection completed, requesting mediation
Sending outbound message ... over WebSocket transport.   (complete, return_route none)
Sending outbound message ... over WebSocket transport.   (mediate-request)
WebSocket closing to wss://mediator.12id.naziharitsolution.com
... 60 s ... Timeout has occurred (requestAndAwaitGrant)
```

**Cause, from the installed `@credo-ts/didcomm` 0.7.0** (`transport/DidCommWsOutboundTransport.mjs`):
```js
const socketId = `${endpoint}-${connectionId}`;
const isNewSocket = !this.hasOpenSocket(socketId);
...
socket.send(...);
if (isNewSocket && !outboundPackage.responseRequested) socket.close();
```
- Sockets are keyed by endpoint **and** connection id.
- The DID Exchange `request` goes out on the out-of-band flow's socket.
- `complete` (`return_route: none`) is sent under the new connection id, so it is treated as a new socket and **closed right after sending**.
- `mediate-request` follows while that socket is being torn down.
- The socket's `onclose` handler then deletes the transport-table entry by the same key.
- The mediator's grant, a `return_route: all` reply on the inbound session, has nothing to land on.

**Scope.** This is a Credo WebSocket client limitation, not a staging or mediator defect. The native Kotlin holder keeps one persistent socket (Phase 0), and it is the holder the mediator's ws-first ordering exists for. Phase 0's S5 passed with a Credo holder only because the mediator was http-first at the time; no Credo holder was ever run against a ws-first mediator over WebSocket.

**Consequences:**
- Any Credo-based client of the mediator (a future Credo holder, test tooling, a Bifold-style wallet) must request mediation over **HTTP**, then pick up either over HTTP (`PickUpV2`) or by opening a socket afterwards.
- `smoke:credo` therefore runs the holder with `HOLDER_OUTBOUND=http`. The issuer keeps HTTP+WS, because it must forward to the holder's `wss://` routing endpoint. `wss://` for a holder stays covered by `smoke:android` with the native holder.

### Result: `smoke:credo` PASSED over the staging edge (2026-09-13 06:52Z)
Run: `HOLDER_OUTBOUND=http PICKUP_STRATEGY=PickUpV2`. The issuer runs HTTP+WS on `https://smoke-issuer.12id…`.

```
issuer DID: did:indy:twelveid:staging:Nm9wqugckgMheEe1eoHKqA
cred def (unqualified, used on the wire): Nm9wqugckgMheEe1eoHKqA:3:CL:10:default
connected through the mediator
credential issued through the mediator
proof isVerified: true
v1 protocol messages: 11
v2 protocol messages: 0
=== smoke:credo PASSED ===
```

**What this run establishes:**
- **W5 M1, TLS (partial).** Connection, issuance and verification all complete through Caddy-terminated TLS, with the issuer over `https://` and forwards over `wss://`. The holder side used `https://` only (see the trap above); `wss://` for a holder is still pending `smoke:android`.
- **W5 M5, cross-replica delivery: confirmed.** Replica traffic during the run:

  | Replica | Received |
  |---|---|
  | `mediator-1` | the holder's `mediate-request`, `keylist-update`, `didexchange/1.1/request`, 4× `messagepickup/2.0/status-request`, 4× `messages-received` |
  | `mediator-2` | **all 5 of the issuer's `routing/1.0/forward` messages**, plus 4× `messagepickup/2.0/delivery-request` answered from the shared queue (`[takeFromQueue] … Limit: 1`) |

  Messages forwarded to one replica were delivered through requests served by either replica, via the shared Postgres pickup queue.
- **did:sov prefix on the wire, confirmed on staging.** The mediator logged the issuer's forwards as `did:sov:BzCbsNYhMrjHiqZDTUASHg;spec/routing/1.0/forward`.
- **Unqualified identifiers and v1 only**, as required (4-init §2.7.1, §2.7.2).

### Finding: with a Postgres pickup queue plus Redis multi-instance delivery, the mediator never sends a webhook
`webhook-sink` recorded **0 POSTs** during the run, although 5 messages were queued for a holder that polls (no live session). 4-init §2.3, from an earlier source read, said that in multi-instance mode "the Redis delivery loader calls the notifier directly". **That is wrong for the Postgres queue.** Traced in image `375518d`:

| Code | Behaviour |
|---|---|
| `apps/mediator/src/config/redisMessageDeliveryLoader.ts` header | "Currently the following queue transport implementations are **not supported**: `PostgresMessagePickupRepository` (message pickup type=postgres). Due to it handling the multi-instance message delivery in the transport implementation." |
| `redisMessageDeliveryLoader` (the only notifier call in multi-instance mode) | Listens only for `MediatorEventTypes.DidCommMessageQueued` |
| Emitters of `DidCommMessageQueued` | Only `StorageMessageQueue` (pickup type `credo`) and `TransportQueueDynamoDb` |
| The Postgres queue (`TransportQueuePostgres.ts:587`) | Emits **`TransportQueuePostgresMessageQueued`** instead |
| `pushNotificationLoader` (the only listener for the Postgres event) | `if (!config.pushNotifications.firebase) return` and `if (multiInstanceDelivery.type !== 'none') return` |

So `MESSAGE_PICKUP__STORAGE__TYPE=postgres` combined with `MULTI_INSTANCE_DELIVERY__TYPE=redis`, which is exactly the configuration 4-init §2.3 recommends and staging runs, has **no code path that sends a push notification or webhook**. Nothing logs this.

**Consequences for §2.3 / §4.8:**
- With the Postgres queue, set multi-instance delivery to **`none`**. The Postgres transport queue already delivers across instances; the smoke run showed forwards received by `mediator-2` served through requests handled by either replica.
- A webhook then additionally requires a `pushNotifications.firebase` block to be present, even if no Firebase project is used (the M3 workaround).
- Both points must be verified by W5 M2/M3 before the push-wake design relies on them.
- Trap for the runbook: **"multi-instance = redis" silently disables push notifications when the queue is Postgres.**

### Note: the staggered start applies on fresh starts only
After adding `mediator-2 depends_on mediator-1: service_healthy`, `deploy.sh mediator up -d` re-ran the migration but **did not recreate `mediator-2`** (`Up 9 minutes (healthy)`): changing `depends_on` does not alter a container's configuration hash. That is acceptable, because the ordering only matters when both replicas provision a fresh store, but it means the change is unverified until the next clean start (Phase 6 failover work). 0 provisioning errors after the deploy; `/health` 202 from outside.

### Result: W5 M2/M3, webhooks with the Postgres queue (2026-09-13 07:0xZ)
Both cases recreated both replicas with the stated environment (checked via `docker inspect`), then ran `smoke:credo` (`HOLDER_OUTBOUND=http PICKUP_STRATEGY=PickUpV2`, so every message to the holder is queued).

| Case | Multi-instance | Firebase block | Push sender log line | Smoke | Forwards queued (mediator-1 / -2) | Webhook POSTs |
|---|---|---|---|---|---|---|
| M4 (earlier run) | `redis` | none | — | PASSED | 0 / 5 | **0** |
| **M2** | `none` | none | — | PASSED, 11 v1 / 0 v2 | 2 / 3 | **0** |
| **M3** | `none` | title + body only | `Initializing push notification sender on queued messages for postgres pickup type and queue and live mode delivery strategy` | PASSED, 11 v1 / 0 v2 | 5 / 0 | **5** |

**Confirmed, run:**
- **With the Postgres queue, a webhook fires only with multi-instance `none` plus a Firebase block.** The block needs only `NOTIFICATION_TITLE`/`NOTIFICATION_BODY`; `projects` may be omitted. That matches the source trace above.
- **Exactly one webhook per queued message**, including while the holder is actively polling, i.e. with the app open. The platform receiver must de-duplicate bursts per `connectionId` (§4.8).
- **Cross-replica delivery works without Redis multi-instance delivery.** In M2, forwards split 2/3 across the replicas and all were delivered.
- **The webhook body carries no token field at all:**
  ```
  POST /mediator  {"connectionId":"35a5beab-5c24-4fa4-8c9e-ee38fb689b01"}
  ```
  4-init §2.3 documents `{ "connectionId": "...", "fcmToken": null }`. In practice `fcmToken` is `undefined` and `JSON.stringify` drops it, so the receiver must treat the field as absent, not null. `connectionId` is the **mediator-side** connection for the holder, which is the key the platform's device-token registry must use.

**Not tested:** whether two replicas can emit duplicate webhooks for one message. In M3 all 5 forwards happened to land on `mediator-1`. The event is emitted only by the replica that queued the message, so duplicates are not expected (inferred from source).

**Pinned mediator configuration** (now in `compose.mediator.yml`; the temporary override file was removed):
`MESSAGE_PICKUP__STORAGE__TYPE=postgres`, `MESSAGE_PICKUP__FORWARDING_STRATEGY=QueueAndLiveModeDelivery`, `MESSAGE_PICKUP__MULTI_INSTANCE_DELIVERY__TYPE=none`, `PUSH_NOTIFICATIONS__WEBHOOK_URL=…`, and the placeholder `PUSH_NOTIFICATIONS__FIREBASE__NOTIFICATION_TITLE`/`NOTIFICATION_BODY`. `CACHE__TYPE=redis` stays, for the cache only.

---

## W7 — Monitoring and alerting (deployed)

> **Phase 7 update (2026-09-23, review M16):** the alerts were infrastructure-only. Added: webhook dead letters and backlog, outbox lag, endorser refusals, edge 5xx, mediator out-of-band growth, and idempotency table size (26 rules now). New sources: Caddy's per-server metrics, and postgres-exporters for `agent_service` (9190) and `endorser_service` (9191), with `monitoring_ro` granted the reads. Each new alert was fired once deliberately and reached Alertmanager. See [`17-phase-7.md`](17-phase-7.md) M16.

**Stack** (`infra/staging/compose.monitoring.yml`, deployed with `EXTRA_SECRETS=mediator deploy.sh monitoring`; first deploy 366 s, mostly image pulls):

| Component | Version |
|---|---|
| Prometheus (7-day retention) | v3.14.0 |
| Alertmanager | v0.34.0 |
| Grafana OSS | 13.0.2 |
| node-exporter (with textfile collector) | v1.12.1 |
| cAdvisor | v0.60.5 |
| blackbox-exporter | v0.28.0 |
| postgres-exporter (custom mediator queue queries) | v0.20.1 |

Everything listens on `127.0.0.1`; only Grafana is published, through Caddy.

**Verified after deploy:**
- **All 13 scrape targets `up`:** prometheus, alertmanager, node, cadvisor, postgres, 4× blackbox-http (genesis `v1`, ledger browser, mediator `/health`, vdr `/genesis`), and 4× blackbox-indy-client (9702/9704/9706/9708).
- **Probe results:**
  - `probe_success=1` for genesis, ledger, mediator and all four client ports.
  - The vdr probe was `0`, because the proxy was still being built at that moment; it is being re-checked after the proxy came up.
  - Certificate expiry **89.9 days** on every host.
- **Queue metrics:** `mediator_queue_messages{state="pending"} = 6`, `{state="sending"} = 0`. These are leftover messages for shut-down smoke holders. They never drain on their own, which is exactly the backlog pattern the queue alert has to be tuned for.
- **Alerts at first evaluation** (both expected): pending `EndpointDown` for vdr (proxy not yet up), and `LedgerWriteProbeMissing` (textfile collector not yet mounted).
- **Grafana** through `https://grafana.12id…`: `/login` 200 with a valid certificate; `/api/dashboards/home` without auth → **401**.
- **Not reachable from outside:** 9090, 9093, 9100, 9101, 9115, 9187 and 3300.
- **Memory:** 1.8 GiB used of 15 GiB with the ledger, mediator, edge and monitoring stacks all running.

**Ledger write probe** (the consensus gap from W1): `infra/scripts/ledger-write-probe.sh` via `12id-ledger-probe.timer`, every 15 minutes.
- First run: `ledger write probe OK: RjNg9wwVBgfyCFCEzoJTDX in 0.189s`.
- Textfile: `ledger_write_probe_success 1`, `ledger_write_probe_duration_seconds 0.189`.
- Alert rules added: `LedgerWriteProbeFailing` (two consecutive failures), `…Stale`, `…Missing`. `promtool check rules` reports 13 rules.
- After redeploying node-exporter with the textfile collector and restarting Prometheus:
  - Prometheus scrapes `ledger_write_probe_success = 1` from node-exporter.
  - All 13 rules are loaded.
  - The vdr probe recovered to 1.
  - **No alerts pending or firing.**

**Open:**
- **Alert email** needs `GMAIL_APP_PASSWORD` added by the owner to `secrets/monitoring.sops.env`; until then alerts are visible only in the Alertmanager and Grafana UIs.
- **Not deployed:** `indy-node-monitor` (validator-info dashboards) and Grafana dashboards; the Prometheus datasource is provisioned.
- **Not done:** deliberately firing each alert once, as the plan's verification requires.
- **The `mediator_queue_messages` threshold is a placeholder.**

---

## W6 — Mediator abuse controls (partly deployed)

> **Phase 7 update (2026-09-22, review M4, M10):** per-wallet invitations are rate-limited, 3 per 10 minutes. The mediator image `-p5` adds `POST /admin/sweep` and `DELETE /admin/connections/:id`. The platform's hourly sweep uses them to delete unused invitations after 24 hours, stale queue rows after 30 days, and revoked wallets' connections and mediations after 30 days. The open-relay surface no longer grows with abandoned wallets. See [`17-phase-7.md`](17-phase-7.md) M4, M10.
>
> **Phase 7 update (2026-09-22, review M1):** the mediator site now caps HTTP bodies at 512 KB at the edge. Image `-p3` caps WebSocket messages at 512 KiB (the `ws` default is 100 MiB). A 700 KB POST gets 413, and a 600 KB WebSocket message is closed with 1009. See [`17-phase-7.md`](17-phase-7.md) M1.

| Control | State |
|---|---|
| `GET /invite` blocked at the edge | **Live.** The mediator serves its invitation unauthenticated (W4); `https://mediator…/invite?_oobid=…` → 404. `/invitation` (with or without parameters) → the mediator's own 404 page, no data |
| Per-IP rate limiting | **Live.** Edge recreated on `12id/caddy-ratelimit:2.11.4` (certificates kept in the volume). Burst of 330 requests to `vdr.` from the workstation within a minute: **119×200, 211×429** against a limit of 120/min. After the switch, all endpoints still answer with valid TLS: genesis 200, ledger 200, mediator `/health` 202, vdr 200, Grafana 200, `/invite` 404, WebSocket upgrade 101 |
| Mediation-record spike alert | **Live.** `postgres-exporter-drizzle` up, 14/14 targets, 14 rules, `mediator_mediations_records{state="granted"} = 7`, no alerts |
| Per-user invitation gating | **Not designed yet** (Phase 3) |

**Rate limiting.**
- **Image:** stock Caddy has no rate limiting. `infra/staging/caddy/Dockerfile` builds `12id/caddy-ratelimit:2.11.4` with `github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db`. Only an old `v0.1.0` tag exists, so it is pinned to a commit. The build took 417 s, and `caddy list-modules` shows `http.handlers.rate_limit`.
- **Rules:** a `per_ip_limit` snippet keyed on `{remote_host}` with a 1-minute window: 300 events on `mediator.`, 120 on `vdr.`. It exempts `10.0.0.0/8` and loopback, because agents on the VM reach the edge by hairpin from the provider gateway `10.1.1.1` (W1) and would otherwise share one bucket. Thresholds are placeholders; a PickUpV1 holder polls over a single WebSocket, which Caddy counts once.
  > **Phase 7 update (2026-09-28, review I2, L1):**
  > - The exemption is narrowed to `10.1.1.1/32`: on a provider network, other customers share the rest of `10.0.0.0/8`. After the change the smokes passed and the edge counted 0 responses with status 429.
  > - The `hardening` snippet now sends HSTS with `includeSubDomains; preload` and strips `X-Powered-By`. A `handle_errors` block gives Caddy's own errors (404, 413, 429, 502) the same headers, so `Server: Caddy` is gone everywhere.
  > - See [`17-phase-7.md`](17-phase-7.md) L1, I2.
- **Validation:** the candidate Caddyfile reports `Valid configuration` on the new image. The same file on stock `caddy:2.11.4` fails with `rate_limit is not a registered directive`, so **the image and the Caddyfile must switch together**; reloading the live stock container with the new file would take the edge down.

**Mediation-record alert.** A second postgres-exporter (`127.0.0.1:9188`) queries `drizzle."DidcommMediation"`. Against the live database it returned `granted | 7 records | 1 created in the last hour`; that one is the phone registering during `smoke:android`. `MediationRequestSpike` fires above 100 new records per hour, a placeholder. Candidate config: `promtool` reports 14 rules, and `compose config` lists 8 services.

**Constraint for per-user invitation gating (Phase 3).**
- Issuers must be able to POST forwards to the same mediator endpoint without authentication.
- DIDComm payloads are encrypted, so the edge cannot tell a `mediate-request` from a forward.

Gating therefore cannot be done in Caddy. It needs either a mediator-side hook that checks a per-user token presented in or alongside the mediation request (a patch to the image, which conflicts with §12.8's pinned-image decision), or a separate mediator endpoint used only for onboarding. Until then the controls are: never publish the invitation (it lives only in mediator logs and the Postgres out-of-band record), rate limits, and the spike alert.

---

## W8 — `smoke:android`: native Kotlin holder against the staging edge (PASSED)

**Setup.**
- **Device:** Xiaomi 2109119DI, Android 14, arm64.
- **App:** the Phase 0 sample app (with the §2.7.4 fork changes, `PickUpV1`) repointed to staging:
  - genesis `https://genesis.12id…/v1/pool_transactions_genesis`;
  - the staging mediator invitation (substituted without printing; `WalletApp.kt.phase0.bak` keeps the LAN version);
  - issuer invitation from `https://smoke-issuer.12id…/phase0/invitation`.
- **Build:** Gradle debug build in 37 s, 52 MB arm64 APK, `adb install` Success.
- **Issuer:** `infra/ledger/src/smoke/smoke-android.ts`, run on the workstation next to `adb`. It is published at `https://smoke-issuer.12id…` through an SSH reverse tunnel (Caddy → VM `127.0.0.1:3200` → workstation). A second forward reaches von-network `/register`.
- **Coverage:** the phone reached the mediator (`wss://`), the issuer (`https://`), genesis over HTTPS and the ledger client ports directly, all over the public internet; nothing on the phone used `adb reverse` or the LAN.

**Result:**
```
issuer DID: did:indy:twelveid:staging:4iuxtaoFgpHA3ApHwWC7wg
cred def (unqualified, used on the wire): 4iuxtaoFgpHA3ApHwWC7wg:3:CL:28:default
[09:11:56.851Z] app launched with a fresh wallet        (workstation clock)
[09:12:00.821Z] app fetched the invitation
[09:12:02.899Z] connected
LIVE result: DONE      (offer -> done in 0.4 s)
[09:12:11.691Z] app force-stopped
[09:12:11.800Z] offer sent while the app was closed
[09:12:26.921Z] app reopened
OFFLINE result: DONE (4.6 s after reopen)
proof: DONE isVerified=true
v1 messages: 9, v2 messages: 0
=== smoke:android PASSED ===
```
Connection used `connections/1.0` (the Kotlin holder's first choice, §2.7). The issuer accepted the unmodified DID document context because it runs Credo 0.7 (§2.7.4).

**Mediator evidence** (VM clock, last 40 min):

| Replica | Received |
|---|---|
| `mediator-1` | `did:sov:…;spec/connections/1.0/request`, `coordinate-mediation/1.0/mediate-request`, `keylist-update`, **16× `messagepickup/1.0/batch-pickup`**, 2× `routing/1.0/forward` |
| `mediator-2` | **22× `messagepickup/1.0/batch-pickup`**, 1× `routing/1.0/forward`, `trust_ping/1.0/ping` |

- **Webhook POSTs:** 3, at 09:11:09.146, 09:11:17.790 and 09:11:37.577. Each came 35–40 ms after one of the forwards (09:11:09.111, 09:11:17.753, 09:11:37.536): one webhook per queued message, now also with the native holder.

**What this closes (confirmed, run):**
- **W5 M1 for a native holder:** the Kotlin holder obtains mediation and collects messages over **`wss://` through the Caddy TLS edge**. The Credo test client could not cover this path (Credo WS client limitation, W8 trap).
- **Pinned pickup configuration on staging:** `PickUpV1` polling + `QueueAndLiveModeDelivery` + multi-instance `none`, with polls spread across both replicas, delivers live messages and messages queued while the app is force-stopped. The offline credential was done 4.6 s after reopening, in line with Phase 0's 1.7 s on the LAN.
- **The §4.8 wake path's server half:** every queued message produced a webhook with the mediator-side `connectionId`.
- **did:sov prefixes on the wire from the native holder**, and unqualified identifiers and v1-only protocols end to end.

**Inference (from timing, not message IDs).** The 3 forwards are the 3 messages only the issuer starts: live offer, offline offer and proof request. Shifted by the measured clock skew, the forwards line up with those sends within about 1 s. The holder's requests, the credential request and the presentation, went directly to the issuer with return routing, which is why `credential-issued` followed `request-received` within about 60 ms without a mediator hop.

### Trap: correlating logs across machines needs one clock
The first evidence query used a `--since` timestamp from the workstation, whose clock was **about 53 s ahead** of the VM (`local 09:13:31Z` vs `VM 09:12:38Z`). It excluded nearly the whole run and showed "1 batch-pickup, 0 forwards, 0 webhooks", which looked like a delivery failure. Re-querying on the VM's own clock showed 38 pickups, 3 forwards and 3 webhooks.

For Phase 2 (§11.16, correlation IDs): timestamps from different hosts cannot be compared across a DIDComm hop. Run NTP everywhere and prefer message or thread IDs over time windows. The phone's clock is a third, uncontrolled source.
