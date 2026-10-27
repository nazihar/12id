# On-premises delivery (MTB theme Q): findings and evidence

Plan: [`28-on-prem-delivery.md`](28-on-prem-delivery.md). Its section "Review (2026-10-25)" lists the ten
points the code review changed before work started.

## Q1: the bundle made self-host-clean (2026-10-25, local, not released)

### Built
| Item | Change |
|---|---|
| Q1.1 third-party images | `infra/compose/third-party.images` (12 lines); `release.sh` appends them to `release.env`; every compose file reads `${NAME_IMAGE:?release.env}`; `backup-postgres.sh` reads `ALPINE_IMAGE` from `release.env`. The repo's committed `release.env` has the lines appended by hand, as `release.sh` would |
| Q1.2 TLS | Caddyfile snippets `tls_acme` (per-site `tls {$ACME_EMAIL}` instead of the global `email`), `tls_files` (`EDGE_TLS_DIR`, default `/opt/12id/tls`), `tls_internal` (rehearsals); every site imports `tls_{$EDGE_TLS}`, staging's extra sites too. `dr-rebuild.sh REHEARSAL=1` sets `EDGE_TLS=internal` instead of editing the Caddyfile |
| Review 1, the private CA in containers | `EDGE_CA_FILE`: mounted at `/etc/12id-ca/ca.pem` (`/dev/null` when unset). Node services get `NODE_EXTRA_CA_CERTS` only when it is set (`${EDGE_CA_FILE:+…}`): agent-provision, endorser-provision, endorser-service, agent-service, platform-provision, platform-api, console, bootstrap-endorser, write-probe. Blackbox and Alertmanager (Go) get `SSL_CERT_DIR=/etc/12id-ca` |
| Q1.3 ledger subnet | `LEDGER_SUBNET_PREFIX` (default `192.168.97`) for the network and the four node IPs |
| Review 5, existing ledger | `LEDGER_CLIENT_TARGETS` for the Indy client probes (default the four ports on `PUBLIC_IP`); `LedgerBelowConsensusReachability` is `n - f` of any `n` (3 of 4 as before); `bootstrap-endorser` refuses a ledger with a transaction author agreement before writing |
| Q1.5 template | `EDGE_TLS`, `EDGE_TLS_DIR`, `EDGE_CA_FILE`, `CONSOLE_AUTH_SECRET_VERSION`, the ledger keys, the tuning and log-level keys |
| Q1.6 secrets | `infra/compose/secrets.list` (34 entries, 31 keys; kinds generate, base64, derived, prompt, optional, empty) and `infra/scripts/check-secrets-list.sh` |
| CI | `.github/workflows/ci-infra.yml`: the secrets check, `bash -n` and `shellcheck -S error` on every script, `docker compose config` of every stack |
| Q1.7 | the bundle tarball carries `infra/self-host.md` |

### Verified
- **Every stack renders** (`docker compose config` with `staging.env` + `release.env`): mediator, agent, ledger, edge, platform, biometric, console, monitoring; ledger-nodes with `LEDGER_NETWORK_NAME` set. Unset `EDGE_CA_FILE` renders `NODE_EXTRA_CA_CERTS: ""` and the `/dev/null` mount; set, `/etc/12id-ca/ca.pem`. `LEDGER_SUBNET_PREFIX=10.77.3` gives `10.77.3.11`–`.14` and `10.77.3.0/24`. The default Indy targets are staging's four; a set `LEDGER_CLIENT_TARGETS` replaces them.
- **`check-secrets-list.sh`:** `34 entries, 31 keys, matches the 34 mounts`. With a mounted key removed from the list, an unmounted key added and a shared key given two kinds, it names all three and exits 1.
- **shellcheck** 0.10.0, error level, every script in `infra/scripts`: clean.
- **TLS, on Linux Docker (WSL, Docker 28.4), stock `caddy:2.11.4` with the three snippets:**

  | Check | Result |
  |---|---|
  | `caddy validate`, `EDGE_TLS` acme / files / internal | valid ×3 |
  | acme with an empty `ACME_EMAIL` | refused at load (`wrong argument count … after 'tls'`): it fails loudly, and `init.sh check` catches it first |
  | Node 22 `fetch` to a host with a private-CA certificate, empty `NODE_EXTRA_CA_CERTS` + `/dev/null` | refused (`SELF_SIGNED_CERT_IN_CHAIN`): what agent-service would hit without review point 1 |
  | the same with `NODE_EXTRA_CA_CERTS` | `ok: hello genesis.bank.test` |
  | blackbox-exporter 0.28, `SSL_CERT_DIR` with `/dev/null` / with the CA | `probe_success` 0 / 1 |
  | blackbox with `/dev/null`, a public site | 1: the placeholder keeps the system roots |
- `infra/ledger` `tsc --noEmit` clean after the TAA check.

## Staging on `v0.11.0-rc.1` (2026-10-25 to 27)
Commit `0aa0260` (everything above and Q2–Q6, except the SDK guide, which publishes with the SDK tag), tag
`v0.11.0-rc.1`; CI built the nine images in about 20 minutes. Installed with the earlier releases' recipe: the
tag's bundle (`git -c core.autocrlf=false archive`) plus `infra/env/staging/caddy/staging.caddy`, `release.env`
built on the VM from the rc's digests and `third-party.images`, the old tree kept as
`/opt/12id/infra.prev-20261025-v0110` and `release.env.prev-0.10.0-rc.2`. Owner's go-ahead: "do these yourself".

| Check | Result |
|---|---|
| `check-secrets-list.sh` on the VM, `compose config` of the seven stacks | ok |
| Deploy | images pulled in 171 s, seven stacks up in 76 s, no failed step; the mediator tables check ok |
| Containers | every one with a health check healthy, no job exited non-zero |
| `check-inspect-clean.sh` | **0 of 33** secret values in 36 containers |
| New settings live | agent-service `NODE_EXTRA_CA_CERTS` empty with `/dev/null` at `/etc/12id-ca/ca.pem`; Caddy `EDGE_TLS=acme`, 6 sites import `tls_acme`; Postgres and Prometheus run the `third-party.images` digests |
| Monitoring | 22/22 targets up, no alert firing; the new `LedgerBelowConsensusReachability` rule loaded and healthy |
| Edge | genesis 200, mediator `/health` 202, agent `/readyz` 200, API `/v1/health` and `/v1/ledger` 200, console 200, vdr 200, `/admin/*` and `/invite` 404, ledger browser 200, Grafana 302, demo `/healthz` 200. The certificate is still Let's Encrypt's (YE1): moving the ACME mail from the global option into each site changed nothing |
| `console-feedback-check` / `approvals-check` / `conditional-gate-check` | **36/36** / **19/19** / **7/7** |
| `e2e:staging` | **4/4** |
| `smoke:platform-credo` | **PASSED** (connection, credential, proof `verified=true`, one wake-up, all signatures valid) |
| `smoke:biometric-credo` | **PASSED 30/30** |

- The `-R 3200` tunnel was opened by Claude this time. Closing it left the VM's end listening (the half-open session of earlier runs); ending that `sshd: ubuntu` process freed the port.
- Rollback: `release.env.prev-0.10.0-rc.2` and the previous tree.

## Q3: the offline kit, spike with the third-party images (2026-10-25 to 27)
On the `12id-init` host, a kit of the 12 third-party images (a `release.env` with only their lines; ours need the
GHCR token), signed with a throwaway minisign key.

| Check | Result |
|---|---|
| `build` | 12 images, every platform, each manifest re-hashed to its digest after the copy; 3.7 GB (registry storage 3.6 GB, tool images 120 MB, binaries 50 MB), 1,077 files; 17 min (the storage on `/mnt/e`, which is slow for small files) |
| `verify` | signature and every sum ok; one byte appended to `bin/age` → `bin/age: FAILED`, "do not use this kit", exit 1 |
| `load`, no `--registry`, on a host holding only the kit's two tool images | 12 images in the local registry with unchanged digests (240 s); `release.env` rewritten (`REGISTRY=127.0.0.1:<port>`, e.g. `POSTGRES_IMAGE=127.0.0.1:5100/postgres:15-alpine@sha256:fe07…`); **Docker pulled all 12 pinned references**; a second load (an upgrade) ok; the registry is back after `systemctl restart docker` |
| `load --registry 127.0.0.1:5097/bank/12id` (a second registry standing in for Harbor) | every image pushed and re-hashed; the rewritten `POSTGRES_IMAGE` pulled from it |

Found and fixed (after the rc.1 tag; in the next one):
- **The tool images came from the internet at `load`.** Saved by digest alone, an image cannot be found by that digest after `docker load` (the classic image store keeps no repository digest), so Docker pulled `registry` and `skopeo` again; an air-gapped host would have stopped there. The kit now saves them under tags (`12id-kit/registry:2.8.3`, `12id-kit/skopeo:v1.16.1`) and `load` uses those.
- **Another program on 127.0.0.1:5000 answered instead of the kit's registry** (on this PC, WSL forwards it to an old Docker Desktop registry from the W2 rehearsal: `manifest unknown`). `load` refuses a busy port it does not own and takes `LOCAL_PORT`.
- **A stopped `12id-registry` container left by a failed attempt was trusted.** `load` now always replaces the container; the images live in the volume.

## Q5: the kit's Maven part (2026-10-25)
`sdk-android/ci/kit-maven.sh`, rehearsed against 0.2.2 (`SDK_VERSION=0.2.2`, 0.3.0 is not published): the four
artifacts from `nazihar/12id-maven` (75 files) and `DEPENDENCIES.md` with **261** release-runtime coordinates of
the SDK and the AWS add-on. A first version listed test libraries (`mockwebserver`, `junit`): a Gradle task option
applies only to the task before it, so `:sdk:dependencies` had printed every configuration. Fixed; the published
POMs never had them.

## Q4: a customer's pull token (2026-10-27)
The owner created the test machine account `Rahman-Sohanur`, gave it **Read on `12id-caddy` only** (Package settings →
Manage access) and a classic `read:packages` token. On the `12id-init` host, in a throwaway Docker config:
`Login Succeeded`; `12id-caddy@sha256:fed1e6bf…` (rc.1) **pulled**; `12id-services@sha256:becb2cbc…`
**refused** (`permission_denied: read_package`). So a personal account's packages do take a collaborator with
Read, per package; no organisation is needed. Owed: the pull fails after the access is removed.

## Q5: SDK 0.3.0 (2026-10-27)
The release key for kits exists (owner, key id `831CF2B84B3533FA`, `infra/12id-release.pub`).

**Found on the phone, fixed: a proof request over several credential definitions matched only the last one (fork
change F11).** `smoke:sdk-biometric-android` (mock) failed twice at step 5: the face check passed, then the sample
logged `no selection` and the proof never finished. The smoke reused `CRED_DEF_ID` `…:CL:2415`, and its template
accepts every version of `smoke-sdk-biometric` (eight definitions, oldest first); the runs that passed before had
each used the newest one. The fork's `queryFromRestrictions` wrote every restriction into one tag map, so each
overwrote the one before and only the last was searched; AnonCreds restrictions are alternatives. Upstream code,
in every SDK release so far, and it defeats schema versioning (4-init §5.1): a holder of an older version could
not answer. Fixed with one clause per restriction joined by Askar's `$or` (`AnoncredsService.credentialQuery`,
`CredentialQueryTest` 4 new tests).

| Check (Xiaomi, Android 14, staging on `0.11.0-rc.1`, sample on `master`) | Result |
|---|---|
| Fork / SDK unit tests, `apiCheck` | 20/20 / 86/86, clean |
| `smoke:sdk-android`, before the fix | **PASSED** (all steps; genesis signature with staging's key) |
| `smoke:sdk-biometric-android` (mock), before the fix | FAILED 10/10 at step 5, twice (above) |
| `smoke:sdk-biometric-android` (mock), with F11 | **PASSED 12/12**: the proof answered with the credential of the older definition |
| `smoke:sdk-android`, with F11 | **PASSED** (all steps) |

## The air-gapped rehearsal (Verification 3, 2026-10-27)
On `12id-init` (WSL, Ubuntu 24.04, Docker 29.9.2, 14 vCPU, 16 GB): a kit of `0.11.0-rc.1` (all 21 images, 4.8 GB,
built in 18 min while the host still had its GHCR login, signed with a throwaway key), then a fresh host: no
container, volume, image or state, `docker logout`, and **every connection outside loopback and private ranges
rejected for the host (iptables `OUTPUT`) and for containers (`DOCKER-USER`)**: `https://ghcr.io` unreachable, a
Docker Hub pull refused. The bundle came from the kit, with `infra/scripts` from the working tree (what rc.2
carries). Environment `rehearsal`: `*.bank.test` in `/etc/hosts`, `EDGE_TLS=files` with a self-made "bank" CA,
`EDGE_CA_FILE`, the containers given the host's address by environment overlays (review point 2), the custody
key on `E:` standing in for offline media.

| Step | Result |
|---|---|
| `offline-kit.sh verify` + `load` | verified; 21 images into 127.0.0.1:5100 (`LOCAL_PORT`, 5000 is taken on this PC), `release.env` rewritten, digests unchanged |
| `init.sh keys`, then `set-secret.sh console SMTP_URL` (the person's value) | as before |
| `init.sh all --ledger new` (1st) | `check` 0 failed (the registry pull from the kit), `secrets`, the ceremony (4 validators, 3 trustees, 4 stewards, `client_ip` the host); **stops, exit 3**, listing the 7 custody files |
| The custody hand-over | each file copied to "offline media" and decrypted there to 64 bytes, then deleted from the host |
| `init.sh all` (2nd) | validators healthy, genesis `v1` signed (sha256 `92afba20…`), the edge served it over the bank CA, both Postgres instances with their roles; **stops, exit 3**, at the endorser with the pipe command (223 s) |
| `age -d … trustee-1.seed.age \| init.sh endorser` | endorser `did:indy:rehearsal:PDNCPtyH6oJBhDfFHw4fXY` and the probe DID created (34 s) |
| `init.sh all` (3rd) | every stack pulled from the kit and deployed, roles again, `check-inspect-clean` 0; timers installed; `verify`: every service healthy, the nine edge probes right, `/v1/ledger` names the genesis, **a ledger write reached consensus**, inspect 0 of 31 |
| `init.sh operator` | `ops@bank.test` created, one-time password printed once |
| `init.sh all` again | exit 0 in 26 s; `.sops.yaml`, the env file, every sops file and every container id unchanged |
| What runs | 28 containers, **0 images whose digest is not in `release.env`**, every image from the kit's registry; Prometheus 21/21 targets up; firing: `Watchdog` only |

Found and fixed (in rc.2):
- **The ledger write probe could not write its metrics** (`EACCES` on `/metrics`): the container runs as the image's `node` (uid 1000) and the directory belongs to the deploy user, uid 1001 here. On staging `ubuntu` is uid 1000, so it worked by chance; a bank's host would not have matched. `deploy.sh` exports the metrics directory's owner (`METRICS_UID`/`METRICS_GID`) and the probe runs as it.
- **The validators' health check killed them while they started.** It counted failures inside the start period, so when every container started at once (here: WSL stopping the idle distro and Docker starting everything again) the four validators, catching up under a load of 16, were ended twice before they settled. Failures now count only once PID 1 is older than the start period (300 s). The same happens to a production host after a reboot.
- `init.sh all` with no terminal and nothing on stdin ran the endorser bootstrap with an empty stdin; it now stops unless the seed arrives through a pipe or a file. Each stop prints the command the operator ran; the ceremony image is pulled quietly.

Test-host quirks, not product findings: WSL stops an idle distro a few seconds after the last command (kept alive with a background `sleep`); its root mount is private, so node-exporter's `rslave` mount failed (`mount --make-rshared /`, which systemd does on a normal host); `wsl.exe` gives stdout and stderr to a Windows file as two handles that overwrite each other (logs are written inside WSL).

Not run against the rehearsal: the Credo smokes and the console e2e from the PC (they need a tenant, an API key and a public webhook receiver in the rehearsal environment); staging ran them on the same images.

## CI blocked by GitHub billing (2026-10-27)
Every workflow on `74660ad` and the tag `sdk-android-v0.3.0` failed without starting: "The job was not started because
recent account payments have failed or your spending limit needs to be increased." So SDK 0.3.0 is **tagged but not
published**, and docs.12id.com still serves the 0.2.2 guide. Owner action: Billing & plans; then re-run
`release-sdk-android` for the tag.

## Q2: `init.sh` (2026-10-25, in progress)

### Test host
A throwaway WSL distro `12id-init` (Ubuntu 24.04 rootfs, disk on `E:\12id-init`), set up like a fresh self-host host: a `deploy` user with passwordless sudo, systemd, Docker Engine 29.9.2 from Docker's repository, Compose 5.6.1, sops 3.9.4, age 1.1.1, minisign 0.11. The bundle is copied into `/opt/12id` as the release tarball lays it out. Environment `rehearsal`: `*.bank.test` in `/etc/hosts`, `EDGE_TLS=files` with a self-made "bank" CA, `EDGE_CA_FILE` set. Our images are private on GHCR and this host has no pull token, so the steps that need them wait for the owner's read token (below).

### Found while testing
- **`set -e` and a function that finds nothing:** `src="$(with_value …)"` ended the script silently, because the function's last test returned 1. Fixed (`return 0`).
- **`EDGE_CA_FILE` in the root-only TLS directory** could not be read by the deploy user for the check and the probes. Docker mounts it as root, so the containers were fine. `init.sh` reads it with sudo.
- **Unattended runs:** an optional secret with no terminal is skipped with a note (it was a stop); a required one stops with exit 3 and names the `set-secret.sh` command.
- `wsl.exe` re-joins a quoted `bash -c` command line, so `$?` printed by such a line is not the script's status; the rehearsal is driven with script files.

### Verified on the test host
| Step | Result |
|---|---|
| `check` without an environment file | copies `template.env` to `rehearsal.env` and fails, as designed |
| `check` with the rehearsal file | every tool, Docker, Compose, the bundle, `release.env`, `secrets.list`, settings, the certificate (dates, all six hosts, key match, chain to `EDGE_CA_FILE`), DNS of the six hosts, ports and disk ok; the registry pull fails with the login message (no token). Exit 1 |
| `keys --offline-recipient age1…` | new host age key, `.sops.yaml` rule (host + offline), `backup-recipients.txt`, a minisign key pair, `GENESIS_SIGNING_PUBLIC_KEY`, `MINISIGN_SECRET_KEY_B64` in `genesis.sops.env`; a second run changes no byte of `.sops.yaml` or any sops file |
| `secrets` without a terminal | 20 keys generated, the optional AWS keys skipped, stops at `SMTP_URL` (exit 3) |
| `secrets` after `set-secret.sh console SMTP_URL` | the rest generated, `MEDIATOR_WEBHOOK_URL` derived; a second run keeps everything |
| Values | `PLATFORM_AGENT_TOKEN`, `CONSOLE_TOKEN`, `MEDIATOR_ADMIN_TOKEN` equal in both stacks; the webhook URL is `http://platform-api:3500/internal/mediator/<MEDIATOR_WEBHOOK_SECRET>`; `BIOMETRIC_MASTER_KEY` is 32 bytes base64; the minisign key in sops equals the file |
| The offline key alone | opens all 8 sops files |
| `postgres` | both instances healthy with `ENDORSER_DID` still empty (the placeholder); `pg-roles.sh all` applied; 6 service roles, none superuser; mediator databases owned by `mediator`; secret files `root:12000 0440`; a second run changes nothing |
| `ledger existing --genesis` (staging's public genesis v2) | 4 validators and `LEDGER_CLIENT_TARGETS` from the file; published as `v1` with sha256 `6ab9bc1a…835a`, the same as staging's; signature verifies with the new key; the mode is recorded and `ledger new` is then refused. The edge start stopped at the private image pull, as expected |
