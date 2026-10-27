# On-premises delivery (MTB theme Q, self-host packaging): plan

**Status (2026-10-27):** done. Released as platform `v0.11.0` and SDK 0.3.0 on 2026-10-27 after the staging regression and the air-gapped rehearsal passed. Planned 2026-10-15; reviewed against the code 2026-10-25 (section "Review" below, which amends Q1–Q3 and the verification). Evidence will go in [`29-on-prem-delivery-findings.md`](29-on-prem-delivery-findings.md).

## Context
MTB's only Mandatory row, 6.30 ("everything on the bank's premises"), depends on this work. So do rows 2.7, 2.12 and 4.1.

Production and a self-hoster already deploy the same release bundle. Still missing:
- a first-time setup, which today is about 30 manual steps in `infra/runbooks/production-bringup.md` and `ledger-ceremony.md`;
- a way to install without reaching GHCR and `maven.12id.com`;
- an SDK that trusts the bank's genesis key;
- a self-host guide.

This was planned as "Later phase — Self-host packaging" in `implement/18-phase-9-production.md`. It also turns W5 (production bring-up) into a scripted run of the same tool.

**Owner decisions (2026-10-15):**
- Release SDK 0.3.0 now. Every app passes its genesis keys; our default keys arrive at W5 as 0.3.x.
- Customers with internet pull with **per-customer GHCR tokens**. Air-gapped customers get a signed **offline kit**.
- The kit's Maven part holds **our 4 artifacts only**, plus a list of their public dependencies.
- `init` supports two ledger modes: **a new own network** (ceremony), or an **existing genesis plus a trustee seed**. Not supported: endorser-only networks.

**Design choice: `init` is a host script in the bundle, not a command in the `ledger-tools` image.** It drives `docker compose`, `sops`, `pg-roles.sh` and `deploy.sh` on the host. Run inside a container it would need the Docker socket. Cost: no new image.

## Review (2026-10-25)
The plan was read against the compose files, scripts and services. The approach holds. Ten points change what gets built; none needs an owner decision.

1. **A private CA must be trusted inside the containers too, not only on phones (Q1.2).** With `EDGE_TLS=files` and the bank's own CA:
   - agent-service, endorser-service and the ledger tools (`bootstrap-endorser`, `write-probe`) fetch the genesis from `https://GENESIS_HOST/…` (`fetchPinnedGenesis`, `write-probe.ts:28`, `bootstrap-endorser.ts:65`);
   - agent-service sends DIDComm forwards to the holder's mediator endpoint, `wss://MEDIATOR_HOST`, through the edge;
   - platform-api delivers webhooks to the bank's own backends, which may carry the same CA;
   - the blackbox probes use `fail_if_not_ssl` against the system CAs.

   Each would fail on an unknown CA. Fix: an optional `EDGE_CA_FILE` (a PEM bundle on the host). When it is set, the Node containers mount it and get `NODE_EXTRA_CA_CERTS`, and blackbox gets `tls_config.ca_file`. Unset changes nothing (staging). Cost: one optional mount per Node service; no image change.
2. **Containers resolve the hostnames through the host's DNS servers, not `/etc/hosts`.** The bank needs internal DNS for the six hosts (the guide says so). The air-gapped rehearsal adds `extra_hosts` in an environment overlay (`infra/env/<env>/compose.<stack>.yml`), which needs no bundle change. The W4 DR rehearsal worked only because its containers fetched the genesis from the real staging host.
3. **Bring-up order (Q2).** `bootstrap-endorser` fetches the genesis through the edge, so the edge starts at the end of the `ledger` step, before `endorser`. Also, Compose interpolates every service of a file: `deploy.sh agent up -d agent-postgres` fails while `ENDORSER_DID` is empty (`${ENDORSER_DID:?}`). `init` passes a placeholder in the shell environment for that one command; shell values win over `--env-file`. `production-bringup.md` and `ledger-ceremony.md` have the same latent problem and are replaced by `init`.
4. **`LEDGER_SUBNET` cannot be split by Compose (Q1.3).** Interpolation has no arithmetic, so the setting is `LEDGER_SUBNET_PREFIX` (the first three octets of a /24, default `192.168.97`). The node IPs are `<prefix>.11`–`.14`. The prefix is written into the genesis by the ceremony; changing it later is a NODE transaction per validator.
5. **Existing-ledger mode needs its own monitoring targets.** The Indy client probes are `PUBLIC_IP:9702–9708`. A new `LEDGER_CLIENT_TARGETS` (default: those four) is filled by `init ledger existing` from the genesis's `client_ip:client_port`. Existing networks with a transaction author agreement are not supported: our NYM writes carry no acceptance (`init` checks `GET_TAA` and stops).
6. **Image digests are index digests (Q3).** Ours (with buildx attestations) and the third-party ones are multi-platform indexes. `skopeo copy --preserve-digests` keeps an index digest only with `--all`, which also copies every platform. The spike measures the kit's size.
   - *Changed while building Q3 (2026-10-25):* the kit holds a **registry's storage directory**, not an OCI layout. An OCI layout cannot hold a Docker-format manifest list byte for byte (skopeo would convert it, changing the digest); registry-to-registry copies keep any format. `load` copies the directory into the `12id-registry` volume and starts the registry, so the customer's side needs no skopeo unless it pushes to its own registry. skopeo also refuses a reference with both a tag and a digest: the kit copies `repo@digest` and tags on the destination.
7. **The genesis signing key also goes into `genesis.sops.env`** (`MINISIGN_SECRET_KEY_B64`, as on staging), so it survives the loss of the VM with the offline key (`init keys`).
8. **Secret kinds are fewer (Q1.6).** `set-secret.sh --generate` gives 64 hex characters, which satisfies `pg-roles.sh` (`[A-Za-z0-9]{24,}`), the Askar store keys and the probe seed. The kinds are: `generate`, `base64`, `derived`, `prompt`, `optional`, `empty`. A key listed under several stacks gets one value.
9. **Rollback across this release needs the previous bundle too.** Its compose files require the new `*_IMAGE` keys, which an older `release.env` lacks. The upgrade section of the guide says so.
10. **The rehearsal's egress block must cover containers.** iptables `OUTPUT` covers the Docker daemon's pulls only; container traffic is forwarded (`DOCKER-USER`). The rehearsal rejects all non-local egress in both chains.

Smaller choices:
- The systemd units keep `User=ubuntu`. `init timers` substitutes the deploy user while installing them, so staging's copy step keeps working. It also writes `/etc/default/12id` (`ENV=`).
- `init check` tests ports 9702–9708 only in `ledger new` mode.

## Progress (2026-10-25)
Built locally, uncommitted (evidence in `29`):
- **Q1** done: third-party images in `release.env`, `EDGE_TLS` (+ `internal` for rehearsals), the private CA inside the containers, `LEDGER_SUBNET_PREFIX`, `LEDGER_CLIENT_TARGETS`, `template.env`, `secrets.list` + its check, `ci-infra.yml`, the bundle carries `self-host.md`.
- **Q2** `init.sh` written; `check`, `keys`, `secrets`, `postgres` and `ledger existing` pass on a fresh WSL host. The steps that need 12iD's private images (`ledger new`, `endorser`, `deploy`, `timers`, `verify`, `operator`) wait for the rehearsal.
- **Q3** `offline-kit.sh` written; the spike ran with the third-party images.
- **Q4** `runbooks/customer-access.md` written.
- **Q5** the SDK guide ("Genesis trust", "Upgrading from 0.2.x", 0.3.0) and `sdk-android/ci/kit-maven.sh` written.
- **Q6** `infra/self-host.md` written; `production-bringup.md` now runs `init.sh`.

**Update 2026-10-27** (evidence in `29`):
- `v0.11.0-rc.1` on staging: every check and both Credo smokes passed.
- The air-gapped rehearsal (Verification 3) passed with a full kit of rc.1; it found three fixes (write probe uid, validator health check at start, endorser stdin), committed for rc.2.
- Q4: a per-package Read collaborator on the personal account works (pull allowed, other package refused).
- The release key exists (`infra/12id-release.pub`, key id `831CF2B84B3533FA`).
- SDK 0.3.0: both phone smokes passed after fork change F11 (proof requests over several credential definitions); **tagged, not published**: GitHub Actions refuses every job (billing).

**Released 2026-10-27:** SDK 0.3.0 on maven.12id.com; platform `v0.11.0` (on `2a08226`, the rc.2 digests; staging runs
`0.11.0-rc.2`, every check and smoke passed). Q4 revocation checked. The reference app moves to SDK 0.3.0 with
staging's key (built by CI; a phone run and its release `reference-app-v4` are left).

Left:
- The MTB gap analysis's theme Q rows (outside the repo, `mtb/Gap_Analysis_Sections_2-6.md`).
- Not run against the rehearsal host: the Credo smokes and the console e2e (staging ran them on the same images).

## What exists and is reused
- `infra/scripts/deploy.sh`: SOPS decryption into `/opt/12id/run-secrets`.
- `infra/scripts/set-secret.sh`: `--generate`, multi-stack values, `--also` for derived values.
- `infra/scripts/pg-roles.sh`: idempotent; run before and again after the first deploy.
- `infra/scripts/snapshot-genesis.sh` (with `MINISIGN_KEY`), `check-mediator-tables.sh`, `check-inspect-clean.sh`.
- `infra/scripts/dr-rebuild.sh`: the host age-key and `.sops.yaml` re-key pattern, and the REHEARSAL `/etc/hosts` pattern.
- The ceremony: `deploy.sh ledger-nodes run --rm ceremony` (`infra/ledger/ceremony/ceremony.py`). It puts custody seeds under age to `/opt/12id/ceremony/recipients/default.txt`.
- `bootstrap-endorser` (`infra/ledger/src/bootstrap-endorser.ts`): takes a trustee seed on stdin, prints JSON with `did`, re-runnable (`result: existing`), registers the probe DID.
- `console-tools`: `npx auth create-admin … --role operator` (`infra/runbooks/console.md`).
- `infra/env/template.env`: every non-secret key.
- `key-rotation.md`: the inventory of every secret.
- SDK master: `OneTwoIdConfig.genesisPublicKeys`, plus `GenesisCache` and `Minisign.kt` (M15).
- `release.sh` (`IMAGES=` the nine images) and `release-images.yml` (the bundle tar, line 56).

## Work

### Q1. Make the bundle self-host-clean (~2 d)
1. **Third-party images move into `release.env`.**
   - Today postgres, valkey, indy_node, the 7 monitoring images, node:22-alpine and alpine:3.22 are pinned inline.
   - New single list `infra/compose/third-party.images`, one `NAME_IMAGE=repo:tag@sha256:…` per line.
   - `release.sh` appends it to the `release.env` it writes.
   - The compose files and `backup-postgres.sh` use `${POSTGRES_IMAGE:?release.env}` and so on.
   - Effect: the offline kit can rewrite every registry prefix in one file and keep the digests.
2. **Caddy TLS modes: `EDGE_TLS=acme|files`.**
   - Default `acme`, so nothing changes on staging.
   - Two snippets in `infra/compose/caddy/Caddyfile`, `(tls_acme)` and `(tls_files)`. Each site uses `import tls_{$EDGE_TLS}`.
   - `files` reads `/opt/12id/tls/fullchain.pem` and `privkey.pem` (one certificate covering the six hosts), mounted in `compose.edge.yml`.
   - The bank's own certificate authority is the bank's to choose; the guide says that phones must trust it.
3. **Ledger subnet configurable:** `LEDGER_SUBNET` (default `192.168.97.0/24`). The node IPs and the ceremony's `NODE_IPS` are derived from it in `compose.ledger-nodes.yml`, because a bank's networks may use that range.
4. **systemd units:** `User=`/`Group=` become a placeholder that `init` fills in. Today `User=ubuntu` is hardcoded in `infra/systemd/12id-*.service`.
5. **`template.env` completed:**
   - adds `CONSOLE_AUTH_SECRET_VERSION`, `EDGE_TLS` and `LEDGER_SUBNET`;
   - adds the optional tuning keys as comments.
6. **Secret manifest `infra/compose/secrets.list`.** One line per secret: `stack KEY kind [shared-with]`.
   - Kinds: `alnum40`, for database passwords and tokens, because `pg-roles.sh` needs `[A-Za-z0-9]{24,}`; `hex64`; `base64-32` (`BIOMETRIC_MASTER_KEY`); `seed` (`LEDGER_PROBE_SEED`); `derived` (`MEDIATOR_WEBHOOK_URL`); `prompt` (`SMTP_URL`, the alert SMTP password); `optional-prompt` (AWS keys); `empty` (`BETTER_AUTH_SECRET_PREVIOUS`).
   - Content: the run-secrets table from the exploration, 34 entries.
   - A test script checks it against the `file:` lines of the compose files, so the two cannot drift.
7. The bundle tar in `release-images.yml` also gets `infra/self-host.md` (Q6) and `third-party.images`.

### Q2. `infra/scripts/init.sh` (~4 d)
- **Steps:** `init.sh <step>`, or `init.sh all`, which runs them in order.
- **Re-runnable:** each step is idempotent and records completion in `/opt/12id/init.state`.
- **Environment:** `ENV` defaults to `production`.
- **Custody steps:** `all` stops at the steps that need a person and prints the exact next command.

| Step | Does | Reuses |
|---|---|---|
| `check` | Docker and Compose versions, `sops`/`age`/`minisign`/`openssl`, passwordless sudo, ports 80/443/9702–9708 free, disk; `$ENV.env` exists (copied from `template.env` if not) and its required keys are filled; DNS of the six hosts → `PUBLIC_IP` (warning only); the registry is reachable and one digest is pullable (token or offline registry) | — |
| `keys` | Host age key (`/opt/12id/secrets/age.key`); writes the `$ENV` rule in `.sops.yaml` with the host key and `--offline-recipient age1…` (required); `infra/env/$ENV/backup-recipients.txt`; the minisign genesis key pair (`/opt/12id/secrets/minisign.key`, plus `--backup-pub` optional), and its public key into `GENESIS_SIGNING_PUBLIC_KEY` | `dr-rebuild.sh` prep pattern |
| `secrets` | Every line of `secrets.list`: generated, shared, derived, or prompted with hidden input. Existing values are kept | `set-secret.sh` |
| `ledger new` | Checks the custody recipients file; ceremony; **pause:** move `custody/*.seed.age` offline; `ledger-nodes up -d`; waits for consensus; `snapshot-genesis.sh v1` signed; writes `GENESIS_SHA256` | ceremony, `snapshot-genesis.sh` |
| `ledger existing --genesis <file>` | Same snapshot and signature from the given file (`EXPECTED_NODES` from the file); no validators started | `snapshot-genesis.sh` |
| `postgres` | Starts the two Postgres containers; `pg-roles.sh all` | `pg-roles.sh` |
| `endorser` | Reads the trustee seed on stdin (`age -d … \| init.sh endorser`); `bootstrap-endorser`; parses `did` into `ENDORSER_DID` | `bootstrap-endorser` |
| `deploy` | `pull` per stack, then mediator (+ table check), agent, biometric, platform, console, monitoring, edge; `pg-roles.sh all` again; `check-inspect-clean.sh` | `deploy.sh` |
| `operator --email --name` | `create-admin` with a policy-valid temporary password, shown once; TOTP at first sign-in | `console-tools` |
| `timers` | Installs the backup and probe units with the deploy user; `enable --now` | `infra/systemd` |
| `verify` | Health of each stack, the ledger write probe, `/v1/ledger` answers with the signature URL | — |

- `phase7-secrets.sh` is left alone. It is staging history, and `secrets.list` supersedes it.

### Q3. Offline kit: `infra/scripts/offline-kit.sh build|verify|load` (~3 d)
- **`build X.Y.Z`** runs on our side with GHCR access.
  - It reads `release-X.Y.Z.env`.
  - `skopeo copy --preserve-digests` puts the 9 images and every `third-party.images` entry into one OCI layout `images/`.
  - `docker save` adds two tool images, `registry:2` and `quay.io/skopeo/stable` (pinned).
  - `bin/` holds static `sops`, `age` and `minisign` (linux-amd64, pinned with sha256).
  - Also included: the bundle tarball, `release-X.Y.Z.env`, and `maven/` (Q5).
  - `SHA256SUMS` is signed with a **new 12iD release minisign key**, held by the owner.
  - Output `12id-offline-X.Y.Z/`. It is too large for a GitHub release asset (2 GB limit) and is handed over directly.
- **`verify`:** checks the signature with the release public key, which the customer receives separately, then the sums.
- **`load [--registry <bank registry>]`:**
  - With no bank registry: `docker load` the two tool images, start `registry:2` on `127.0.0.1:5000` (volume `12id-registry`, restart always), then `skopeo copy --preserve-digests` from the OCI layout into it.
  - It rewrites `REGISTRY` and the `*_IMAGE` prefixes in `release.env`. **The digests stay ours**, so what runs is provably our release.
  - With `--registry` it pushes into the bank's Harbor or Nexus instead.
- **Spike first (½ d):** confirm on the rehearsal host that `--preserve-digests` yields identical digests in `registry:2`, and that compose pulls `…@sha256` from `127.0.0.1:5000` over plain HTTP. Docker allows plain HTTP to localhost registries.

### Q4. Per-customer pull tokens (~1 d, mostly runbook)
- **New runbook `infra/runbooks/customer-access.md`:**
  - one GitHub machine account per customer (`12id-<customer>`);
  - granted Read on the nine `ghcr.io/nazihar/12id-*` packages (package settings → Manage access);
  - a classic PAT with `read:packages` only. GHCR does not accept fine-grained tokens;
  - the customer stores it with `docker login ghcr.io` on their host;
  - revoking = removing the account's access.
- First step: verify on one package that user-owned GHCR packages accept a collaborator with Read. If they don't, the fallback is moving the packages to a GitHub organisation (owner decision).
- `maven.12id.com` stays public on GitHub Pages: the SDK ships inside apps anyway.
- `init check` validates the token with a pull by digest.

### Q5. SDK 0.3.0 release (~1 d) and the kit's Maven part
- `sdk-android/docs/integration.md`:
  - a "Genesis trust" section: `genesisPublicKeys` is required, takes one or more minisign `.pub` lines, and one valid signature is enough;
  - replace "verified by checksum" (line 72);
  - a self-host note: the bank's key, and the bank's CA in the app's network security config when the edge uses `files` TLS.
- Release notes: apps must pass `genesisPublicKeys`, because the default list is empty until W5. Also in 0.3.0: the 429 retry (F10).
- `services/VERSIONS.md`: SDK 0.3.0; fix the biometrics-mock version, which says 0.2.0.
- Tag `sdk-android-v0.3.0`. CI publishes it (`release-sdk-android.yml`).
- The sample and the reference app pass the staging key (`infra/env/staging/genesis-signing.pub`). Reference app v4 on 0.3.0.
- **Kit `maven/`:**
  - the `com/12id/**` subtree for the released versions, from the `nazihar/12id-maven` checkout;
  - `DEPENDENCIES.md`, generated from `./gradlew :sdk:dependencies :biometrics-aws:dependencies --configuration releaseRuntimeClasspath`, for the bank's Nexus proxy.

### Q6. Self-host guide: `infra/self-host.md` (~2 d)
- Shipped in the bundle. Not on docs.12id.com: `docs/site/build.sh` refuses `infra/` paths, and the guide is for licensees.
- **Sections:**
  - what runs (stacks, ports, hostnames);
  - sizing (the W4 numbers: about 600 open wallets per two mediator replicas, 8 vCPU / 32 GB start);
  - the host (Ubuntu, Docker pinned, ufw, the ledger client ports);
  - getting images (token or offline kit);
  - DNS and TLS (`acme` or `files`, phones trusting a private CA);
  - custody (offline age key, trustee and steward seeds, minisign keys: who holds what);
  - `init.sh all` step by step;
  - the first operator and the first organisation;
  - the SDK (0.3.0, `genesisPublicKeys`, the Maven part);
  - the face-check provider (AWS today; theme D for an on-prem vendor);
  - backups and the off-site pull;
  - upgrades (the next bundle → `deploy.sh <stack> pull` + `deploy.sh <stack>`; migrations are compatible for one release; rollback);
  - monitoring and alert mail;
  - the runbooks shipped alongside.

### Q7. Release (~½ d)
- Platform `v0.11.0-rc.1` on staging, then `v0.11.0`.
- On staging, Q1 changes nothing: `EDGE_TLS=acme`, same subnet, same digests.

## Files
- **New:**
  - `infra/scripts/init.sh`
  - `infra/scripts/offline-kit.sh`
  - `infra/compose/secrets.list`
  - `infra/compose/third-party.images`
  - `infra/self-host.md`
  - `infra/runbooks/customer-access.md`
  - `infra/scripts/check-secrets-list.sh` and `.github/workflows/ci-infra.yml` (review)
  - `sdk-android/ci/kit-maven.sh` (the kit's Maven part)
  - `implement/28-on-prem-delivery.md` (this plan)
  - `implement/29-on-prem-delivery-findings.md`
- **Changed:**
  - `infra/compose/compose.{mediator,agent,ledger-nodes,monitoring,edge}.yml`
  - `infra/compose/caddy/Caddyfile`
  - `infra/scripts/{release.sh,backup-postgres.sh}`
  - `infra/systemd/*.service`
  - `infra/env/template.env`
  - `.github/workflows/release-images.yml`
  - `infra/runbooks/production-bringup.md`: now "run `init.sh`"
  - `sdk-android/docs/integration.md`
  - `services/VERSIONS.md`
- **Status notes:** `implement/4-init-post-phase-0.md` §10 and §12.15, the 18 "Later phase" section, and the theme Q rows of `mtb/Gap_Analysis_Sections_2-6.md`.

## Verification
1. **Unit:** `secrets.list` against the compose files (the new check script). `bash -n` and shellcheck on the new scripts. SDK JVM tests and `apiCheck`.
2. **Staging regression** (`0.11.0-rc.1`):
   - every service healthy;
   - `check-inspect-clean.sh` reports 0;
   - `smoke:platform-credo`, `smoke:biometric-credo` 30/30 and console `e2e:staging`;
   - `smoke:sdk-android` on the phone with SDK 0.3.0 and the staging key;
   - a negative check: a wrong key in `genesisPublicKeys` fails at init.
3. **Air-gapped rehearsal** on a fresh WSL Ubuntu (the `dr-rebuild.sh` REHEARSAL pattern):
   - Setup: egress to ghcr.io, docker.io, quay.io, gcr.io and maven.12id.com blocked with iptables OUTPUT reject.
   - Steps: `offline-kit.sh verify` + `load`, then `init.sh all` with `ledger new`, `EDGE_TLS=files` and a self-made CA; hostnames in `/etc/hosts`.
   - Then from the PC, with `NODE_EXTRA_CA_CERTS`: `smoke:platform-credo`, `smoke:biometric-credo` (mock) and the console e2e against it.
   - Pass criteria: `check-inspect-clean.sh` reports 0, the write probe reads 1, `docker image ls --digests` equals `release.env`, and `init.sh all` run a second time changes nothing.
4. **Ledger mode `existing`:** `init.sh ledger existing --genesis` against staging's von-network (known test trustee seed). The endorser is written, and the probe passes.
5. **Tokens:**
   - a test machine account pulls one digest;
   - after its access is removed, the pull fails.
6. Evidence goes in `implement/29-on-prem-delivery-findings.md`.

## Owner actions
- **The release minisign key for kits:** generate it offline and decide who holds it. Its public key is given to customers outside the kit.
- **A GitHub machine account per customer** (GHCR tokens).
- **Confirm** that SDK 0.3.0 release notes saying "every app passes its genesis key" are acceptable to the reference/demo users.

## Size
About 3 weeks for one engineer: Q1 2 d, Q2 4 d, Q3 3 d, Q4 1 d, Q5 1 d, Q6 2 d, rehearsal and release 2–3 d.
