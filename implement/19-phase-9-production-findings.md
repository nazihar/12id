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

## W3 — Android SDK release and CI (started 2026-09-30)

### Summary
| Item | Built | Verified |
|---|---|---|
| Decisions | Two artifacts (SDK + fork merged; native), GitHub Pages Maven repository `maven.12id.com`, CI on tags (owner, 2026-09-30; `18-…` W3) | — |
| 5b.1 native | `sdk-android/native/`: `build.sh` (upstream tag `0.2.1`, cargo-ndk 4.1.2, NDK r27c, Rust 1.77.2, API 24, 3 ABIs), upstream bindings reused, `com.12id:holder-sdk-native:0.2.1-12id.1` | **`smoke:sdk-android` PASSED on the phone (7/7) and on x86_64 emulators API 26, 28, 36 (steps 1–3)**; native instrumentation test on API 24, 36, 37 (16 KB pages) and the phone |
| 5b.2 SDK artifact | Fork sources + vendored `java-multibase` compiled into `:sdk`; `third_party/m2`, `mirror-uniffi.ps1` and JitPack retired; `-PpublishRepo` | fork JVM tests 4/4, SDK 44/44, `apiCheck` clean; the published POM names only `com.12id:holder-sdk-native` (no `org.hyperledger`, no JitPack) |
| 5b.3 CI | `.github/workflows/ci-{services,console,sdk-android}.yml`, `release-{images,native,sdk-android}.yml`, `sdk-android/ci/maven-repo.sh`; `release.sh tag` takes `X.Y.Z-rc.N` and a source version | written, **not run yet**: needs the push and the owner's one-time GitHub setup (`18-…` W3) |
| M15 | — | not started (needs W5's production minisign keys for the default) |

### Native build (5b.1)
- **Root cause of trap 42 confirmed.** Rust links Android libraries with `-nodefaultlibs`, so compiler-rt's builtins
  are left out unless the linker is told; upstream's `cross` build did not. `cargo-ndk --link-builtins` fixes it: no
  rebuilt library imports `__extenddftf2` or any symbol outside the API 24 stubs of `libc`/`libm`/`libdl`/`liblog`.
- **`build.sh` checks its own output** (the check upstream would have failed): allowed `NEEDED` entries only, every
  imported symbol present in the API-level stubs, 16 KB `LOAD` alignment on the 64-bit ABIs, exactly the three
  `*_uniffi.so` per ABI.
- **Two build problems the check caught:**
  - Indy VDR (ZeroMQ is C++) was left importing the whole C++ runtime (`__cxa_throw`, `operator new`, …) and needed
    no libc++: the `-lc++_static` that `cc` emits sits before `libzmq.a` on the link line, so it resolved nothing, and
    a shared library links with undefined symbols anyway. Fixed by linking `libc++_static` + `libc++abi` again at the
    end (`RUSTFLAGS` for Indy VDR only). The AAR ships no `libc++_shared.so` (upstream did).
  - `cargo ndk -o` also copied dependency crates built as cdylibs (`libaries_askar-<hash>.so`, …). `build.sh` now
    copies only the wrapper libraries.
- **Size (arm64):** 6.9 + 7.7 + 5.2 = 19.8 MB for the three libraries, against 44.4 MB upstream (with its
  `libc++_shared.so`). The native AAR is 24 MB (three ABIs).
- **Build time:** 65 min for the first build (14 cores, WSL; OpenSSL and ZeroMQ from source), about 1 min cached.
- **Build host:** this PC's C: is full and Docker Desktop hangs, and the owner's Ubuntu WSL disk is on C:. A separate
  WSL distro `12id-build` (Ubuntu 24.04, disk on E:) runs `build.sh`; `wsl --unregister 12id-build` removes it. CI
  uses `ubuntu-24.04`.

### Device evidence (2026-09-30, rebuilt libraries)
- **Phone (Xiaomi, Android 14, arm64): `smoke:sdk-android` PASSED 7/7** — onboarding Ready; connect; offer accepted →
  done, declined → abandoned; offline offer with wake webhook → done; proof verified, second declined; restart keeps
  2 credentials and the mediation; spent invitation Ready after 26 s; all webhook signatures valid. The native
  instrumentation test passed there too.
- **x86_64 emulators, steps 1–3 PASSED on API 26, 28 and 36** (onboarding, connect, offer accept/decline). This is the
  first time the SDK has run on an emulator (Phase 5 finding 9).
- **API 24 (Android 7.0): the native libraries load** (instrumentation test: Askar, AnonCreds, Indy VDR calls pass), but
  at first **the SDK could not reach the platform** (fixed the next day, below): `CertPathValidatorException: Trust anchor for certification path not found`.
  Android 7.0's trust store lacks ISRG Root X1 (added in 7.1.1), and Let's Encrypt no longer serves the cross-signed
  chain. New finding, below.
- **16 KB pages (API 37 `ps16k` emulator):** the native instrumentation test passed; Android noted
  `PAGE_SIZE_APP_COMPAT_FLAG_ELF_NOT_ALIGNED` because JNA 5.7.0's **x86_64** `libjnidispatch.so` is 4 KB aligned (its
  arm64 build is 64 KB aligned, ours are 16 KB). The smoke there did not reach the native layer: the stand-in customer
  backend took 39 s to create the wallet on staging and the sample's token call timed out (twice).
- The smoke's `adb logcat -c` is now best effort: the API 26 image refuses it ("failed to clear the 'main' log").

### Found on the way
- **minSdk 24 and Let's Encrypt — fixed 2026-10-01.** The owner keeps `minSdk 24` (the first customer requires it).
  Staging's chain is `YE1 → Root YE → ISRG Root X2 → ISRG Root X1`; Android 7.0 has none of those roots.
  - **Fix (fork change F8, `IsrgTrust`):** the SDK and the fork carry the four Let's Encrypt roots (X1, X2, YE, YR)
    and check them only after the system trust store rejects a chain, on every HTTPS/WSS client (platform API,
    genesis, mediator HTTP + WebSocket, invitation short URLs). Hostname verification and the app's network
    security config are unchanged. YE/YR also cover older devices once Let's Encrypt drops the cross-signs.
    Fingerprints checked (X1/X2 against the published values, YE against the Root YE staging sends) and pinned
    by `IsrgTrustTest`. Fork JVM tests 8/8, SDK 44/44, `apiCheck` clean.
  - **The sample** gets the same roots in a network security config for its own backend: a customer app needs
    that only for its own Let's Encrypt servers (integration guide).
  - **Verified:** `smoke:sdk-android` steps 1–3 **PASSED on the API 24 emulator** (Ready 4 s after launch), and the
    full 7 steps **PASSED again on the phone** with the fix in.
  - On the way: raising the sample's backend timeout to 60 s made step 4 fail twice on the phone. The first token
    request of a push-woken process never reaches the backend and hangs until the timeout; the default 10 s
    recovers in time, 60 s did not. Reverted. The woken process also asks for the token several times (5 in the
    passing run); worth a look when the SDK's token path is next touched.
  - The fork's `ktlintCheck` is broken independently (ktlint-gradle 13 refuses the pinned ktlint 0.49.1); CI does
    not run it.
  - The smoke tunnel went stale once (the window still open, requests hanging): open it with
    `-o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes`.
- **The async Askar call hangs in the instrumentation test, with the upstream libraries as well.** `provision` never
  completes inside the `:native` test APK on API 24 and 36 (also with upstream's arm64 libraries under ARM translation),
  while the same call works in the app on every device above. All Rust threads are idle in the dump, so the continuation
  callback is not reaching Kotlin in that harness. The test is `@Ignore`d with this explanation; the app path is covered
  by the smoke.
- **JNA 5.7.0 is not 16 KB aligned on x86_64** (emulators only). A JNA bump would clear the compat-mode notice; the
  bindings use no API that changed since 5.7.
- **Auto mode refuses some staging actions** even with an allow rule (a reverse tunnel, and writes on a remote host
  without an explicit per-action go-ahead). The owner opens the smoke tunnel themself.

### First release (2026-10-01)
- **`native-v0.2.1-12id.1`:** CI built the libraries (65 min) and ran the native test on x86_64 emulators API 24, 26, 28
  and 36. Three fixes to `release-native.yml` on the way:
  - API 36 never booted: `Not enough space to create userdata partition (7309 MB available, 7373 MB needed)`. The
    emulator job now frees disk first (.NET, Haskell, Boost, Swift) and uses a 6 GB data partition and 3 GB RAM
    (private-repo runners: 2 vCPU, ~7 GB).
  - The first version of that clean-up also deleted the tool cache, where `setup-java` had installed the JDK, and all
    four emulators failed at "Install Android SDK". The clean-up now runs first and keeps the tool cache.
  - A re-run uses the workflow of the tagged commit, so each fix meant moving the (unpublished) tag.
- **The libraries CI built** pass the same checks as the local build: `NEEDED` only `libc`/`libm`/`libdl`, no
  `__extenddftf2` or C++ runtime import (only libc's `__cxa_atexit`/`__cxa_finalize`), 16 KB aligned, 3 ABIs.
- **`sdk-android-v0.1.0`:** the first run failed safely at the sample build (before publishing):
  `maven.12id.com` still served GitHub's `*.github.io` certificate. GitHub's DNS check had hung for a day with
  correct DNS; re-saving the domain restarted it and Let's Encrypt issued `CN=maven.12id.com` (until 2026-12-30). The
  re-run published the SDK and both add-ons.
- **Customer path verified:** the sample (debug + minified release) built with the local repository removed and every
  `com.12id` artifact downloaded from `https://maven.12id.com`; **`smoke:sdk-android` PASSED 7/7 on the phone** with
  that build. Smoke keys revoked.
- **Repository:** `nazihar/maven` was renamed `nazihar/12id-maven`; its default branch is `master`.
- CI audit: `ci-console` failed on a high `brace-expansion` advisory from dev tooling only. `npm audit fix`
  (lockfile only) cleared it; both checks now audit `--omit=dev` (what ships, L12).

### Not done yet in W3
- M15 (minisign on device).
- The 16 KB smoke once staging's wallet creation is fast again.
- M10's phone check (re-onboarding after a `never_connected` revocation).

## W4 — Phase 8 Hardening (started 2026-10-01)

**Owner choices (2026-10-01):**
- The load test runs on staging, generated from the dev PC over the real Caddy/TLS path. It ramps to staging's knee, and the 10k target is re-run on the production VM in W5.
- Holders are hybrid: real Credo onboarding, then a lightweight PickUpV1 driver.
- Every rotation is rehearsed live on staging, after a backup.
- The whole-VM DR rehearsal runs now in a WSL distro on E:; the gating drill comes after W5.

Plan: `C:\Users\arad\.claude\plans\read-the-md-files-dreamy-cookie.md` (A load, B failover, C rotation, D DR).

### Summary
| Item | Built | Verified |
|---|---|---|
| A1 load tools | `infra/load/`: `onboard.ts` (real Credo holder per wallet; keys exported from its Askar store), `poll.ts` (PickUpV1 like the SDK: batch-pickup every 10 s, one HTTP/2 connection per wallet, ramp steps, stop rule, JSON per step), `inject.ts` (forwards to the mediator → queue → wake webhook), `delivery-report.ts`, `exchanges.ts` (A4), `cleanup.ts` + `cleanup.sql`, `local-mediator.ts` | `didcomm.test.ts` 5/5, including Credo's own envelope service reading ours and vice versa; local end to end against a Credo mediator: 300 wallets onboarded, 20 injected → 20 picked up, 0 lost, 0 duplicated |
| A2 sampler | `infra/scripts/load-sampler.sh` (TCP established on :443/:3001/:3002, Postgres backends by database/state, textfile metrics) | syntax only; runs on the VM |
| A4 knobs | `ASKAR_MAX_CONNECTIONS` (credo-base `postgresStore`, agent + endorser config); compose passes `AGENT_PROCESS_MESSAGES_CONCURRENTLY`, `AGENT_TENANT_SESSION_LIMIT`, `AGENT_/ENDORSER_ASKAR_MAX_CONNECTIONS` from the env file, defaults = behaviour before W4 | credo-base 26/26, agent-service 60/60, endorser-service 33/33 |
| B1 validator self-heal | `compose.ledger-nodes.yml`: client-port healthcheck; three failures end PID 1 (tini) and the restart policy restarts the node (the vdr-proxy pattern) | YAML parsed; rehearsal on staging (`w4l`) pending |
| C rotation tools | `set-secret.sh`: several stacks at once, `--also` derived keys, `--generate-base64`, `--from`; `rotate-biometric-key.sh` + `rotate-master-key.ts`; `rotate-askar-key.sh` + `credo-base/src/askar-rekey.ts` (+ mediator `askar-rekey` one-shot); `bootstrap-endorser.ts --rotate / --demote`; console versioned `BETTER_AUTH_SECRET` (`auth-secrets.server.ts`, `scripts/reencrypt-2fa.ts`, `console-reencrypt` one-shot) | set-secret against a stand-in sops; biometric 35/35 (3 new, real Postgres); Askar rekey 2/2 against real Postgres (two profiles, old key refused, re-run detected); console Vitest 39/39 (5 new), build + `check:client` clean; ledger `tsc` |
| C/D runbooks | `runbooks/key-rotation.md` (inventory of every secret + one procedure each), `runbooks/disaster-recovery.md` (scenarios, restore order, whole VM); links from backup-restore, biometric-service, console, genesis-rotation | written; "Rehearsed on staging" lines pending |

### Found on the way
- **The DIDComm v1 content cipher is ChaCha20-Poly1305 IETF with a 12-byte nonce,** although the header says
  `xchacha20poly1305_ietf` (what Credo, ACA-Py and the Kotlin framework all write and read). The first packer used
  XChaCha (24-byte nonce) and round-tripped with itself, but Credo refused it. The cross-test with Credo's
  `DidCommEnvelopeService` caught this before staging.
- **The SDK polls over HTTPS, not the WebSocket** (`MessageSender` picks the mediator connection's first service;
  Phase 5 observed https with return-route). At 10k wallets that is about 1,000 HTTPS requests a second through
  Caddy. `mediator_per_ip` (300/min) counts every poll: one phone uses 6/min, so a carrier NAT with more than
  about 50 open apps would hit it. A2 measures this; it decides M1's `mediator_per_ip`.
- **Credo's PickUpV1 handler deletes queued rows before it sends the batch** (`takeFromQueue … deleteMessages: true`),
  so a replica killed between the two loses those messages. B2 measures it.
- **`BETTER_AUTH_SECRET` encrypts every TOTP secret,** so the "rotate it, everyone signs out" note (console.md) would
  have broken every 2FA enrollment. Better Auth 1.7.4's versioned secrets plus the re-encryption one-shot keep them;
  `CONSOLE_AUTH_SECRET_VERSION=0` keeps today's behaviour exactly.
- The driver costs about 1.6 ms of CPU per poll (pack + unpack), about 630 polls/s per core, so the PC is not
  the bottleneck at 10k (1,000/s).
- The DB tests found a local Postgres on 127.0.0.1:55432 (`TEST_DATABASE_URL` default) that the Phase 2 tests use;
  the biometric and Askar rekey tests ran against it.

### B1 validator failover on staging's von-network (2026-10-04)
- **One of four down** (`docker stop von-node4-1`, 04:34Z): a vdr-proxy NYM read answered 200 in 0.09 s, and the write
  probe passed in 0.18 s. `LedgerClientPortUnreachable` for :9708 went pending.
- **Two of four down** (node3 as well, 04:34:48Z): reads still answered 200 (f + 1 = 2 replies), and the write probe failed
  after 45 s.
  - `LedgerClientPortUnreachable` (×2) and `LedgerBelowConsensusReachability` were firing in Alertmanager by 04:39.
  - `LedgerWriteProbeFailing` went pending at 04:36:16 and fired at about 04:56 (its 20 min `for:`); Alertmanager had all three.
- **Restart** (05:03:04Z): the write probe passed 16 s later, and all four client ports answered. Neither node hung at start this time.
- Still the owner's: confirm the `[FIRING]` / `[RESOLVED]` mails for these three alerts reached the ops address.
- **Rollout and CI:**
  - The first image release, `v0.1.0-rc.1` (W5 step 0), failed with `No space left on device` while building the nine images
    (indy-vdr-proxy's cargo build). `release-images.yml` now frees disk first (the tool cache too: no `setup-*` here), the
    unpublished tag was moved, and the second run passed (run 37177377935, commit `0c2401c`).
  - Polling the Actions API every minute from two loops tripped GitHub's secondary rate limit; poll every few minutes.

### Staging on `v0.1.0-rc.1` (2026-10-04)
- **Deploy:** the infra tree was swapped, the old one kept as `/opt/12id/infra.prev-w4`, and every stack was deployed from the rc.
  - GHCR now downloads at about 10 MB/s on the VM (W2 measured 21 KB/s), so all nine images pulled in under 4 minutes.
  - The VM needed a GHCR login first: the owner added a `read:packages` token with `docker login`.
- **Checks:** every service healthy; `check-inspect-clean.sh` 0 of 32; 22/22 targets up; edge probes as before;
  `smoke:platform-credo` PASSED, `smoke:biometric-credo` 18/18, `e2e:staging` 3/3.
- **Trap: `git archive` on Windows applies `core.autocrlf`.** The first tree reached the VM with CRLF scripts
  (`/usr/bin/env: 'bash\r'`) and was replaced before any deploy. Use `git -c core.autocrlf=false archive`.

### A — mediator load test on staging (2026-10-04)
- **Setup:**
  - tenant `load-w4` (per-key limit 0);
  - 3,000 wallets onboarded in about 13 minutes (0 failures);
  - the generator PC exempt at the edge;
  - polls over HTTPS/HTTP/2, one connection per wallet, every 10 s (the SDK's profile);
  - injected forwards at 2 per second;
  - `load-sampler.sh` running on the VM.
- **First ramp: HTTP 500 at 1,000 wallets (about 100 polls/s), 72 % then 99.8 % of polls.**
  - The mediator logged `TimeoutError` (Credo's 10 s processed-message wait), and mediator Postgres was at 137 % CPU,
    running one statement at a time:
    `select … from "Did" where context_correlation_id = $1 and ((alternative_dids @> $2 or did = $3) and role = $4)`.
  - `alternative_dids` had no index, and the OR forced a **sequential scan of `Did`: 88 ms, 9,514 buffers at 6k rows**
    (23 MB table), on every poll. M18's index list missed this column.
  - **Fix: `12id_did_alternative_dids_gin`** in `infra/compose/mediator/indexes.sql`; the plan becomes a BitmapOr of
    two index scans, **0.17 ms**. Applied on staging with the `mediator-indexes` one-shot.
- **Second limit: the mediator process.** With the index, Postgres sat at 10–30 % CPU while each replica held a full core.

  | Wallets (polls/s) | p50 | p95 | p99 | Errors |
  |---|---|---|---|---|
  | 200 (20/s) | 42 ms | 80 ms | 151 ms | 0 |
  | 400 (40/s) | 47 ms | 125 ms | 217 ms | 0 |
  | 600 (60/s) | 130 ms | 691 ms | 914 ms | 0 |
  | 800 (80/s) | — | — | — | 36 %, then 100 % HTTP 500 |

  - **Two replicas on staging's 4 vCPU (shared with four von-network validators at about 0.6 of a core) carry 600 open
    wallets; the knee is between 60 and 80 polls/s.**
  - Past the knee there is **no recovery while the load lasts**. The serial queue keeps processing requests whose
    HTTP session has already timed out (`http transport session has been closed`), and every poll fails until the load
    drops; the backlog then takes about 4 minutes to drain. **Memory reached 509–512 MiB of 512 MiB** and stayed there
    after the load; a restart cleared it.
- **CPU profile of one replica at 20 polls/s** (Node inspector, 30 s; the replica was restarted afterwards to close it):
  - 54.5 % idle, so about **22 ms of CPU per poll**: one replica tops out near 40–45 polls/s.
  - The busy time is spread across Credo's per-message work: reply encryption 6.4 %; the holder's `did:peer:4`
    resolution about 5 % (pure-JS base58 decode 3.6 %, `@stablelib` key conversion 3.6 %); garbage collection 6.9 %;
    zod, drizzle and class-validator about 1–3 % each. No single hotspot.
  - **Caveat:** these wallets were onboarded by Credo holders, which pick DID Exchange and `did:peer:4`; the SDK uses
    `connections/1.0` (`did:peer:1` in the mediator). `onboard.ts --handshake connections` reproduces the SDK's path.
