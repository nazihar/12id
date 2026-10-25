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
