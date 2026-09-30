# Phase 9 — Production: findings and evidence

Plan: [`18-phase-9-production.md`](18-phase-9-production.md). W0 and W1 left their evidence in
[`17-phase-7.md`](17-phase-7.md); this file starts with W2.

## W2 — Production-capable infra (2026-09-29)

### Summary
| Item | Built | Verified |
|---|---|---|
| W2.1 Per-environment config | One set of compose files (`infra/compose/`); `infra/env/<env>.env` (+ `template.env`); `{$VAR}` Caddyfile; staging-only parts as overlays in `infra/env/staging/`; `deploy.sh` with `ENV=` | **Staging switched 2026-09-29; every smoke passed unchanged** |
| W2.2 M11 file secrets | `resolveFileEnv` (services, console), mediator entrypoint, Postgres/Grafana/exporters/Alertmanager native `_FILE`; `deploy.sh` writes `/opt/12id/run-secrets` | **`docker inspect` clean: 0 of 32 secret values in 35 containers (88 exposures before)** |
| W2.3 M17 image-only bundle | `infra/build/compose.build.yml`, `release.sh build/tag`, `release.env`, every base image pinned by digest | 9 images pushed (local registry, then GHCR); staging runs `sha-f4d1849-dirty` by digest |
| W2.4 M13 off-site backups | Second (offline) age recipient in `.sops.yaml` and backups; atomic backup dirs; `backup-pull.sh` (rrsync read-only, 30 daily + 12 monthly) | Pull from another machine, key confined; **restore with the offline key only passed** |
| W2.5 Production ledger | `compose.ledger-nodes.yml`, ceremony image + `ceremony.py`, trustee-signed `bootstrap-endorser`, `write-probe.ts`, vdr-proxy healthcheck | **Rehearsed as a scratch project on staging**: ceremony, consensus, trustee bootstrap, probe, 1-of-4 and 2-of-4 failover |
| W2.6 Runbooks | `ledger-ceremony.md`, `production-bringup.md`, `genesis-rotation.md` (move a validator), `backup-restore.md` (off-site + offline drill) | written |

### Decisions and exceptions taken during W2 (2026-09-29)
- **Images built on the staging VM once (owner decision).** This PC's C: drive filled up (0 MB free) during the
  local rehearsal and Docker Desktop hung on it twice, so `release.sh build` ran on id-dev from a copy of the
  working tree (`/opt/12id/build-src/w2-20260929`, version `sha-f4d1849-dirty`: commit `f4d1849` plus the
  uncommitted W2 tree). Recorded as an exception to "nothing is built on a VM"; production is unaffected, and
  from W3 CI builds everything.
- **GHCR namespace `ghcr.io/aradnazihar`, not `ghcr.io/nazihar`.** `nazihar` is a separate GitHub user account,
  and GitHub lets only an account itself create packages in its namespace: a push with the `aradnazihar`
  token got `permission_denied: create_package`. The registry is one value in `release.env` (`REGISTRY`), so
  moving to `nazihar` or an organization later is a re-push, not a code change.
  - **Decided the same day (owner): `ghcr.io/nazihar`.** The nine images were retagged on the VM and pushed
    with a `nazihar` token (stdin only, a tmpfs config removed at exit). Every digest was identical to
    `release.env`. Staging was redeployed from `ghcr.io/nazihar`; containers were recreated, health probes
    passed, and `check-inspect-clean.sh` stayed at 0 of 32.
  - The copies under `ghcr.io/aradnazihar` are left for the owner to delete (GitHub → Packages).
- **The token used was a broad classic PAT** (repo, admin:org, delete_repo, write:packages, …), given in chat
  and to be rotated by the owner afterwards. It was never written to disk on this PC; on the VM it lived only
  in `/dev/shm/12id-ghcr` (tmpfs) for the build and the pulls, then was removed. Production needs a
  **read:packages-only** token on the VM (`production-bringup.md`).

### Things found on the way (traps)
- **GHCR is slow from id-dev: ~21 KB/s down**, against ~330 KB/s from GitHub release downloads and ~350 KB/s
  from Docker Hub on the same VM (measured with curl on a GHCR blob). The public `indy_node` image (430 MB)
  would have taken ~6 h. It was fetched on this PC (7.4 MB/s) as an OCI archive and loaded on the VM with its
  digest intact (containerd image store). **For W5: measure GHCR from the production VM before relying on it**;
  a slow link turns every deploy into hours.
- **Uploads from id-dev run at ~1.25 MB/s**, so pushing the release from the VM took about half an hour.
- **`sum.golang.org` resets connections intermittently** from both this PC and the VM (the Caddy build's
  `xcaddy` step failed once on each); a retry passed. CI should retry that step.
- **Compose does not recreate a container when a mounted secret file changes** (checked: same container id
  after the file changed and `up -d`). `deploy.sh` therefore labels every secret-reading container with
  `io.12id.secrets-rev`, a hash of the stack's secrets, so `up -d` still recreates on a change, as it did with
  environment values.
- **Compose interpolates every service of a file, profile or not.** A `${VAR:?}` in a profile-only service
  fails every command on that file, so the ceremony lives in `compose.ledger-nodes.yml` (production only) and
  its settings are required there, not in the tools file staging uses.
- **The console build context included `console/.staging/`** (plaintext staging credentials, review L8):
  `console/.dockerignore` did not exclude it and the build stage does `COPY . .`. The images built on the VM
  so far were safe only because the VM's copy of the tree never had that directory. Fixed: `.staging` and
  `e2e` are excluded, and `services/.dockerignore` now excludes `**/.env*` (`spikes/.aws-spike.env`).
- `.gitignore` ignored the new `infra/build/` (`build/`) and every `*.env`; the non-secret `infra/env/*.env`,
  `release.env` and `infra/build/` are now allowed explicitly.
- A root-owned backup directory from the Phase 1 drill (`/opt/12id/backups/20260914T065830Z`) could not be
  rotated or pulled by `ubuntu`; its owner was changed to `ubuntu` (nothing deleted).
- **systemd removes a user's `/dev/shm` files when their last session ends** (logind `RemoveIPC`): the
  temporary GHCR login in `/dev/shm/12id-ghcr` vanished between SSH sessions, and the first push of the
  release was `denied` for that reason. Anything a script keeps in `/dev/shm` must live within one session
  (`deploy.sh`, `set-secret.sh` and `check-inspect-clean.sh` do).
- **`deploy.sh` bugs found on the first real run, both fixed:** under `pipefail`, `[ -f overlay ] && grep`
  in a pipeline failed for a stack without an overlay and `set -e` exited silently; the EXIT trap's
  `[ -n "" ] && rm` became the script's exit status. Both are `if` statements now.
- **A read-only bind mount cannot host a nested mount point:** mounting the environment's extra Caddy sites
  at `/etc/caddy/sites.d` inside the read-only `/etc/caddy` failed at container start, and the staging edge
  was down for about 2 minutes until they moved to `/etc/caddy-sites`.

## W2 evidence (staging, 2026-09-29)

### The switch (W2.1–W2.3)
- **Order:** prep (tree swapped, the old one kept as `/opt/12id/infra.prev-w2`; genesis copied to
  `/opt/12id/genesis`; `.sops.yaml` and `sops updatekeys` for the offline recipient; `MAIL_FROM` moved from
  `console.sops.env` to `staging.env`), then `deploy.sh` mediator → agent → biometric → platform → console
  → monitoring → edge, all with `ENV=staging` and the images of `infra/compose/release.env`.
- **Unit tests after the change:** credo-base 21/21 (9 new for `file-env.ts`), agent-service 59/59, endorser-service
  32/32, platform-api 100/100, biometric-service 32/32, console Vitest 34/34 (2 new); `tsc` clean in every package
  and in `infra/ledger`.
- **Every stack's `compose config` validated** on the VM before the first `up`.
- **Mediator:** migrate and `mediator-indexes` exited 0, both replicas healthy, `check-mediator-tables.sh
  --after-start` all ok. In the container: files `-r--r----- root:12000`, the process runs as `agent` with
  supplementary group 12000, and `ADMIN_API_TOKEN` is not in the container's environment.
- **Agent, biometric, platform, console:** provision jobs exited 0, services healthy, 0 restarts.
- **Monitoring:** 22/22 targets up; `external_labels.environment` expands to `staging`; the blackbox targets
  and the Alertmanager config come from compose `configs`, and `/run/secrets/GMAIL_APP_PASSWORD` is readable
  by Alertmanager.
- **Edge probes from outside (`17-phase-7.md` §4):** genesis 200, mediator `/health` 202, vdr 200, agent
  `/readyz` 200, api `/v1/health` and `/v1/ledger` 200, console `/api/health` and `/login` 200, ledger browser
  200, Grafana 200; `/admin/*`, `/internal/*`, `/invite`, a genesis 404 → 404; `/register` 403; smoke issuer
  502 (no listener); `X-Console-Token` → 404; HSTS `max-age=31536000; includeSubDomains; preload`; no
  `Server` or `X-Powered-By`.
- **M11 gate — `infra/scripts/check-inspect-clean.sh`:** before the switch **88 exposures across 34
  containers**; after: **`clean: 32 secret values, 35 containers, 0 found in docker inspect`** (values and
  their percent-encoded forms, in every container, running or not).
- **Smokes, unchanged:** `smoke:platform-credo` PASSED (all webhook signatures valid, 0 pending);
  `smoke:biometric-credo` PASSED 18/18; console `e2e:staging` 3/3 (CSP guard, TOTP, invitation mail through
  the `SMTP_URL` secret file); ledger `bootstrap-endorser` → `existing`
  `did:indy:twelveid:staging:9WnSruRkr6b3V7XX9zPjka`; `smoke:credo` PASSED (`isVerified: true`, 11 v1
  messages, 0 v2).
  - `smoke:credo` needs `HOLDER_OUTBOUND=http` and `PICKUP_STRATEGY=PickUpV2`, as Phase 1 found (Credo's WS
    client fails the mediation handshake with a ws-first mediator). The staging overlay's defaults were the
    failing `http,ws` + live mode; they are now the passing pair.
  - **`smoke:sdk-android` PASSED on the phone (Xiaomi `lisa`, Android 14), 2026-09-30,** after staging moved
    to `ghcr.io/nazihar`.
    - The sample APK was rebuilt with the current SDK (M14 included); Gradle's cache and temp went to E:
      because C: is full.
    - All 7 steps passed: onboarding Ready; connect; offer accepted → done and declined → abandoned; offline
      offer with a wake webhook, done; proof verified, second request declined; restart keeps 2 credentials
      and the mediation; a wiped wallet with a spent invitation is Ready again after 25 s. All webhook
      signatures valid.
    - The holder uses `wss://` through the mediator's 512 KiB WebSocket cap (M1).
    - **M14 on the device:** the app log had 197 lines, 50 Info and 147 Warn, and no Debug or Verbose line.
    - The phone had 441 MB free (Android refuses to install); the owner freed space first.
- **vdr-proxy recovery:** the edge container runs under tini (`/sbin/docker-init` as PID 1). A scratch copy
  whose healthcheck points at a closed port restarted 3 times in 50 s (three failed probes → `kill 1` →
  restart policy); the tmpfs `/tmp` resets the count each time.

### Found on staging while switching: the von-network pool had lost consensus (not caused by W2)
- `LedgerWriteProbeFailing` had been firing since **2026-09-28 12:28Z**, a day before this work. Validators 3
  and 4 of von-network hung at "Starting ledger..." at 12:23Z (their client ports refused connections), so
  only 2 of 4 were up: reads worked, writes did not.
- Fixed with `docker restart von-node3-1 von-node4-1` (they caught up, view 148), then
  `docker restart von-webserver-1` (its pool handle stayed "Not ready") and the vdr-proxy. The write probe
  passed right after (24.5 s).
- For W4 (failover): a node that hangs at start is restarted by nothing, and the alert fired for 21 h without
  anyone noticing. The owner should confirm that alert mails arrive (`18-phase-9` owner actions).

### W2.4 M13 off-site backups
- `backup-postgres.sh` (new) through the reinstalled `12id-backup.service` (`EnvironmentFile=/etc/default/12id`):
  13 files, each encrypted to **2 age recipients** (the VM key and the staging offline key), genesis
  included, written to `.incomplete-<stamp>` and renamed.
- **Pull:** WSL on the dev PC stood in for the backup machine, with its own key in `authorized_keys` as
  `command="/usr/bin/rrsync -ro /opt/12id/backups",restrict`. Two pulls: 11 copies, all checksums verified,
  status 0; the second pull changed nothing. The key cannot run a command (`rrsync error:
  SSH_ORIGINAL_COMMAND does not run rsync`), cannot write (`sending to read-only server is not allowed`),
  and cannot leave the directory (`do not use .. in arg`). The rehearsal key was removed from the VM
  afterwards; the owner's backup machine gets its own.
- **Drill with the offline key only** (never the VM's key, and the key never left the PC): the newest pulled
  copy verified, then `agent-platform_api`, `agent-console` and `agent-endorser_service` decrypted and restored
  into a throwaway Postgres: 11 tenants and 8 console users (both equal to live), 46 wallets, 98 endorsement
  audit rows. The only errors were GRANTs to `monitoring_ro`, a role the scratch instance lacks (a real
  restore runs `pg-roles.sh`). The genesis archive and `agent.sops.env` opened with the same offline key.
- **Owner action:** the staging offline private key is at `E:\12id-credo\offline-keys\staging-offline-age.key`
  on the dev PC; move it to offline storage and delete it there. Production gets its own offline key (W5).

### W2.5 our own ledger, rehearsed as a scratch project on staging
Environment `w2r`: its own env file, secrets and `run-secrets-w2r`, project names `w2r-*`, client ports not
published (von-network holds 9702–9708), clients on `12id-ledger`. Removed afterwards.
- **Ceremony** (`deploy.sh ledger-nodes run --rm ceremony`, no network): 3 trustees, 4 stewards, 4 validators,
  7 custody files (`*.seed.age`, 264 bytes each); the log contains no seed (0 matches).
- **Validators:** all four started with `INDY_NODE_SEED=[0 characters]` and "Keys directory exists, skipping
  init", elected Node1 primary in view 0, no errors; node ports only on the private network.
- **Genesis v1** published with `snapshot-genesis.sh` from the ceremony file, minisign-signed, 4 validators.
- **Trustee-signed endorser bootstrap:** the "offline holder" (WSL) decrypted `trustee-1.seed.age` with the
  offline key and piped it into `deploy.sh ledger run --rm -T bootstrap-endorser`. It signed as
  `DLYcGp7B6N7UNoXL2f4Ksy`, the ceremony's Trustee1 (so the in-process Ed25519 derivation matches plenum's),
  and created the endorser (role ENDORSER, key generated in its Askar store) and the probe's role-less DID.
- **Write probe (`write-probe.ts`):** 4/4 validators OK in 0.2 s; node4 stopped: OK; node3 and node4 stopped:
  `FAILED after 30.1s: Pool timeout` (writes stop, as they must with 2 of 4); both restarted: OK. It writes
  the same `ledger_write_probe_*` series as the von-network probe, so the alerts carry over.
- **vdr-proxy** on the new genesis read the endorser NYM back.
- **Backups:** with the validators' volumes present, the nightly script added `ledger-node1..4.tar.gz.age`
  (66–136 KB); one decrypted to the node's `keys/Node2/private_keys/…` and the genesis.

### Not done in W2 (on purpose or blocked)
- **The full local rehearsal (Docker Desktop):** blocked by the dev PC's full C: drive; the owner chose to
  rehearse on staging instead. The local run did prove `release.sh` (9 images built and pushed to a local registry).
- ~~**`smoke:sdk-android`** (phone)~~: passed 2026-09-30 (above).
- **L2 on staging:** staging keeps its public Grafana and ledger browser (now in
  `infra/env/staging/caddy/staging.caddy`); production has neither, which closes L2 for production.
- **Staging stays on von-network:** L16 stays open for staging only; production uses the new ledger stack.
- **CI (W3)** replaces `release.sh` on a VM; W3 also settles the final GHCR namespace.

### Left on the VM
- `/opt/12id/infra.prev-w2` (the old tree, for a rollback) and the old images (`12id/services:phase7` …):
  delete after a few days of stable staging.
- `/opt/12id/build-src/w2-20260929`: the copied source the images were built from.
