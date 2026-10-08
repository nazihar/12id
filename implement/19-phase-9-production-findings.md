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

## W3 — Android SDK release and CI (2026-09-30 to 2026-10-01; done except M15 and the M10 phone check)

### Summary
| Item | Built | Verified |
|---|---|---|
| Decisions | Two artifacts (SDK + fork merged; native), GitHub Pages Maven repository `maven.12id.com`, CI on tags (owner, 2026-09-30; `18-…` W3) | — |
| 5b.1 native | `sdk-android/native/`: `build.sh` (upstream tag `0.2.1`, cargo-ndk 4.1.2, NDK r27c, Rust 1.77.2, API 24, 3 ABIs), upstream bindings reused, `com.12id:holder-sdk-native:0.2.1-12id.1` | **`smoke:sdk-android` PASSED on the phone (7/7) and on x86_64 emulators API 26, 28, 36 (steps 1–3)**; native instrumentation test on API 24, 36, 37 (16 KB pages) and the phone |
| 5b.2 SDK artifact | Fork sources + vendored `java-multibase` compiled into `:sdk`; `third_party/m2`, `mirror-uniffi.ps1` and JitPack retired; `-PpublishRepo` | fork JVM tests 4/4, SDK 44/44, `apiCheck` clean; the published POM names only `com.12id:holder-sdk-native` (no `org.hyperledger`, no JitPack) |
| 5b.3 CI | `.github/workflows/ci-{services,console,sdk-android}.yml`, `release-{images,native,sdk-android}.yml`, `sdk-android/ci/maven-repo.sh`; `release.sh tag` takes `X.Y.Z-rc.N` and a source version | **run:** `native-v0.2.1-12id.1` and `sdk-android-v0.1.0` released 2026-10-01; `release-images` first ran with `v0.1.0-rc.1` on 2026-10-04 (one disk-space fix) |
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
- **The SDK's handshake does not change the knee.** 1,000 wallets onboarded over `connections/1.0` (`did:peer:1` in
  the mediator, like the 38 real SDK connections) gave 400 wallets: p95 124 ms; 600: p95 563 ms; 800: collapse
  (15 %, then 100 % errors). The limit is the mediator's per-message cost, not `did:peer:4` resolution.

### A4 — agent throughput (reviews L9, M1, M2; 2026-10-04)
30 full Credo holders, each behind the mediator, ran offer → accept → done in a loop for 5 minutes through the
public API, over a background of 300 polling wallets.

| Agent setting | Exchanges/min | offer → done p50 | p95 | p99 | agent-service peak | agent Postgres peak |
|---|---|---|---|---|---|---|
| serial (`PROCESS_MESSAGES_CONCURRENTLY=false`, today) | **119** | 15.4 s | 20.7 s | 22.0 s | 0.70 core | 0.27 core |
| concurrent (`true`) | 113 | 15.7 s | 26.9 s | 36.2 s | 0.43 core | 0.30 core |

- No errors either way. The time per exchange is the holders' pickup cycles through the mediator (two mediated
  messages per exchange), not agent-service: it never reached a full core.
- **Decision for now: keep serial processing** (no gain, a worse tail); staging was reverted. Revisit when one
  agent-service process holds a core.
- **L9:** Askar's Postgres pool showed 10 connections to `agent_root` (Askar's default) and was never short;
  `ASKAR_MAX_CONNECTIONS` stays unset.

### B2 — mediator replica failover under load (Phase 1 M6; 2026-10-04)
Load for every run: 300 wallets polling (30/s), forwards injected at 5/s for 3.5–6 min, and every message id
tracked (`delivery-report.ts`).
- **`docker kill` is not a crash test.** Docker never restarts a container an operator killed or stopped, whatever
  its restart policy: mediator-1 stayed `Exited (137)`, `restarts=0`, until started by hand. The surviving
  replica carried everything; **0 of 1,641 accepted messages were lost, 0 duplicated**. But 158 forwards and up to 43 %
  of polls per minute got 503: whenever the lone replica missed Caddy's 3 s health check, Caddy had no healthy
  upstream left.
- **A real crash (`kill -9` of the replica's process from the host), clean run:** Docker restarted it
  (`restarts` +1) and it was healthy **12 s** later.
  - Errors only in that minute: 19 polls (1.05 %) and 2 of 1,050 forwards (502/503).
  - **0 lost, 0 duplicated**; delivery p50 5.1 s, p99 10 s.
- **The delete-before-send window is real.** Credo's pickup v1 takes rows with `deleteMessages: true` before writing
  the reply. In a run disturbed by a leftover second outage, one message (1 of 897), queued 10 s before the kill,
  never arrived. Clean runs lost none. **Owner decision (2026-10-06): accepted, no patch.** The options were: accept it (narrow window; the exchange is
  abandoned by reconciliation and re-offered) or a `-p7` patch that deletes only after the reply is written.
- **Fix: Caddy retries the other replica.** `lb_try_duration 5s` / `lb_try_interval 250ms` on the mediator site:
  a refused connection to a dead replica is retried on the live one.
  - Crash run again: **all 1,050 forwards accepted**, one poll error in the whole run (0.06 %), 0 lost, 0 duplicated.
  - Applied on staging (Caddyfile).
- **Open: a replica exited cleanly (code 0, nothing logged) twice.** mediator-1 at 07:53:35 and mediator-2 at 07:59:51,
  each about 4 min 21 s after a crash restart, and each restarted by Docker in about 12 s.
  - Not reproduced by a plain mass disconnect.
  - Nothing in the mediator, its queue package or `pg-pubsub` calls `process.exit`.
  - The mediator now runs with `NODE_OPTIONS=… --trace-exit`, so the next one logs the stack.
- The staging VM's clock runs **22 s behind** the dev PC (matters when matching logs).
- **Trap:** stopping a backgrounded test script left its remote steps running, and it killed mediator-2 later. Check for
  leftovers (`Get-CimInstance Win32_Process … b2-run.sh`) after stopping a test.

### C — every key rotated live on staging (2026-10-04)
Each step followed `runbooks/key-rotation.md`, after a fresh backup, with the smokes afterwards; the section's
"Rehearsed" line has the detail.

| Secret | Result |
|---|---|
| Seven internal and admin tokens (shared ones through `set-secret.sh a,b`, the webhook URL through `--also`) | five stacks redeployed in 74 s; smokes, biometric 18/18, e2e 3/3; inspect 0 |
| `AGENT_SERVICE_DB_PASSWORD` (+ `pg-roles.sh`) | healthy, 0 authentication failures |
| `BETTER_AUTH_SECRET` (version 0 → 1, `console-reencrypt`) | 6 TOTP enrollments kept; e2e 3/3 before and after the previous secret was removed |
| Biometric master key (`rotate-biometric-key.sh`) | 3 tenant keys re-wrapped; biometric 18/18 |
| Askar store keys, agent / endorser / mediator (`rotate-askar-key.sh`) | scratch restores first (all `rekeyed`), then live: 26 s / restart / 50 s of downtime; smokes; existing wallets keep polling |
| Endorser DID (`bootstrap-endorser --rotate`, `--demote`, von-network's trustee) | new endorser `NiDNzVvC7DfuJ5s3itjp5Q`; an existing tenant's schema carries it; a new tenant onboarded; the old one reset to role null |
| Genesis signing key | genesis v2 signed by `B84C710C4BA2C31C`; `/v1/ledger` → v2 |
| VM age key | 8 files re-keyed; the old key refused; deploy and backup on the new key |

**Found on the way** (all fixed):
- `bootstrap-endorser.ts` treated an empty `LEDGER_PROBE_SEED` secret file as a seed and failed after the rotation.
- `set-secret.sh` dropped a piped value with no final newline (`read` returns non-zero at end of input, and `set -e` ended the script silently).
- `snapshot-genesis.sh` inherited the caller's umask, so a version directory published under `umask 077` was 0700 and the non-root vdr-proxy crash-looped. It now sets 0755/0444.
- My own load-test receiver held port 3201 and made two smokes fail with `EADDRINUSE`; stop it before a smoke.

**Owner:**
- Move `/opt/12id/secrets/minisign.key.prev-w4` offline, or delete it.
- Delete `/opt/12id/secrets/age.key.prev-w4` once the offline key is confirmed to open the older backups.
- Staging's tenants keep working; tenant `w4-endorser-rotation-check-…` is a leftover of the endorser check.

### D — disaster recovery (2026-10-04)
- **D1:** `runbooks/disaster-recovery.md`: scenarios, what restores together (`agent_root` with `agent_service`;
  `drizzle` with `mediator`), what users see, the single-database procedure, the whole VM.
- **D2, every database into a scratch Postgres on the VM:** the newest backup's checksums verified, 10 dumps
  restored in 12 s. Tenants 16, wallets 4,129, `agent_root` items 6,402, endorsement audit 135, console users 9,
  biometric keys 3, mediations 4,157, mediator Askar items 4,168, queued messages 378: **every count equals live**.
  - The live "queue lost" drill was not run: the load tenant's queued rows can't be isolated without a
    cross-instance join, and deleting rows would only show they are gone.
- **D3, whole-VM rehearsal in a WSL distro (`12id-dr`, Ubuntu 24.04, Docker Engine 29.1) on E:, from the repo, a
  pull by the real `backup-pull.sh`, and the staging offline key only:**
  - **Pull:** a dedicated key confined to `rrsync -ro`: 13 copies (160 MB) in 16 s.
  - **Prep:** a new host age key; all 8 sops files re-keyed to it with the offline key; the genesis (v1, v2,
    current) restored. The backup was taken after the VM's age-key rotation (C8), so only the offline key could
    open it.
  - **Restore:** the two Postgres instances, roles, 10 dumps with the offline key, roles again: 36 s.
  - **Deploy:** every stack from `v0.1.0-rc.1` in 331 s (image pulls included), after the owner logged the host into
    GHCR. The hostnames pointed at the host and Caddy used `local_certs` (rehearsal only: no public DNS or ACME).
  - **Check:** all 12 services healthy. agent-service and endorser-service only start if their restored Askar
    stores open with the recovered keys. Counts equal to the backup; edge probes 200/202.
  - **Through the restored data:** the API created a connection invitation (the tenant's wallet in `agent_root`),
    a wallet plus its mediator invitation (the restored mediator), and listed connections and the catalogue.
  - **About 8 minutes of machine time**, plus host setup (about 10 min) and the owner's GHCR login.
  - Scripted as `infra/scripts/dr-rebuild.sh` (`prep|restore|deploy|check`; `REHEARSAL=1` for hosts without DNS).
    It now also deploys monitoring, which the rehearsal did not run.
  - Afterwards the DR copy (live keys) was stopped, the distro unregistered (its GHCR login and copied
    backups with it), and the pull key removed from staging.
- **Found:**
  - **`pg-roles.sh all` failed on a fresh instance** (`relation "DidcommConnection" does not exist`): it granted
    `monitoring_ro` and `platform_ro` on tables that only exist after the services' first start. That is the order
    `production-bringup.md` uses, so a new production VM would have stopped there too. The table grants are now
    conditional (`to_regclass … \gexec`), and the runbooks run `pg-roles.sh all` again after the restore or first deploy.
  - The pull copied two stray files from staging's `/opt/12id/backups` into `daily/` as if they were backups
    (`agent.sops.env.pre-unset-20260928`, `mediator-endorser-predrop-20260928.dump.age`). Owner: move them out of
    the backup root or delete them.
  - A DR host needs the GHCR read token; it is now listed as an input in `disaster-recovery.md`.

## W7 — Customer-facing documents (2026-10-05)
- **New `services/platform-api/docs/credential-model.md`:** what a credential is, validity (`expiresAt` and its
  automatic predicate), no revocation and what to do instead, wallet recovery ("accept the loss, issue again" as a
  one-step flow), attribute-encoding recipes (dates as `YYYYMMDD`, amounts in the smallest unit, yes/no as 1/0),
  schema immutability and a checklist before the first schema.
- **`data-protection.md` revised:**
  - backups as they are since W2 (two keys, one offline; off-site; 30 daily + 12 monthly, so erased data leaves the
    monthly copies within 12 months);
  - where the data is hosted (the country is left for the owner);
  - sub-processors;
  - a security-measures overview.
- **Found while writing: the 2038 limit.** Credo encodes an attribute as an integer only within the signed 32-bit
  range (`encodeCredentialValue`) and hashes anything larger. The offer builder accepted any 1–12-digit `expiresAt`,
  so a credential valid past **2038-01-19 03:14:07 UTC** would be issued and then fail the mandatory
  `expiresAt >= now` predicate in every proof. Offers past `2147483647` are now refused with a clear message
  (agent-service `builders.ts`; tests 9/9, agent-service 61/61); the OpenAPI description and `api.md` say so. The
  same limit applies to any attribute used in a predicate (documented).
  - **Decided (owner, 2026-10-06): expiry is now a date.** The mandatory attribute is `expiresOn` = `YYYYMMDD` (UTC), accepted through the end of that day; proofs check `expiresOn >= today`; any date to 9999. Clean break: `expiresAt` (epoch seconds) is retired, with no compatibility path (staging test data only). Code: agent-service `builders.ts` (`isCalendarDate`, `utcDateNumber`), platform-api `views.ts` `expiryOf` (the next midnight UTC), the console, smokes; the SDK reads `expiresOn` into the unchanged `expiresAtEpochSeconds` (0.2.1). Needs a platform release (`v0.2.0`) and SDK 0.2.1. Original question: keep epoch seconds (validity capped at 2038), or change the expiry unit before the first
    customer (an API contract change).
- **Publishing (owner decision 2026-10-05): `docs.12id.com` on GitHub Pages**, same pattern as `maven.12id.com`.
  - `docs/site/` holds the landing page, the Pages config and an API reference page (Redoc 2.5.4, SRI-pinned, rendering
    `openapi.json`).
  - `docs/site/build.sh` assembles the guides, rewrites repo paths into site links, and refuses any internal path. It
    caught the SDK guide naming an internal smoke script, which was reworded.
  - `.github/workflows/docs.yml` publishes to `nazihar/12id-docs` on every docs change, and skips with a notice until
    the owner's setup exists (`18-…` W7).
- `openapi.json` was checked against the code (regenerated, no drift) before the one description change; the
  console's typed client was regenerated with it.

### W4 cleanup (2026-10-05)
- **Load tenant `load-w4`:**
  - its 4,060 wallets were revoked through the public API (`cleanup.ts`, which now waits out the edge's 429s) and aged
    past the 30-day grace (`cleanup.sql` phase A);
  - **platform-api's hourly sweep then removed every one of their mediations through the mediator's admin route**
    (mediations 4,157 → 97): review M10's sweep, exercised at scale;
  - the rows were deleted (phase B), its API key was revoked, and its webhook endpoint removed.
- **Staging:** the generator's rate-limit exemption is removed and `load-sampler.sh` is stopped.
- **Dev PC:** the DR distro and its pull key are gone.

## W5 step 0 — the first platform release (2026-10-04/05)
- `v0.1.0-rc.1` (2026-10-04): the first `release-images.yml` run failed on runner disk space; the workflow frees disk
  first now, and the re-run passed. Staging ran it for all of W4.
- `v0.1.0-rc.2` (2026-10-05, the W4 fixes): built by CI (about 35 min); not deployed, superseded by rc.3.
- `v0.1.0-rc.3` (commit `4dd3680`, + the W7 2038 expiry guard): built in 5 min (build cache). On staging every service is
  healthy on the rc.3 digests, all migration and provision jobs exited 0, `check-inspect-clean.sh` 0 of 32, 22/22 targets,
  `smoke:platform-credo` PASSED, `smoke:biometric-credo` 18/18, `e2e:staging` 3/3. (A first smoke run failed only
  because the owner's `-R 3200` tunnel had dropped.)
- **`v0.1.0` (2026-10-05):** tagged on `4dd3680`; CI added `0.1.0` to the rc's digests. `release-0.1.0.env` from the GitHub
  release carries exactly the nine digests staging tested, and production deploys it.
- Asset downloads need `Accept: application/octet-stream` only; a JSON `Accept` returns the asset's metadata instead.
- **Published 2026-10-05:**
  - The owner created `nazihar/12id-docs`, Pages and the `docs.12id.com` CNAME, and added `DOCS_REPO_TOKEN`.
  - The `docs` workflow (run 37283213115, dispatched by hand) assembled and pushed the site.
  - `https://docs.12id.com` serves the landing page, the four guides, the Redoc API reference and `openapi.json` (all 200).
  - The certificate is `CN=docs.12id.com` (valid until 2027-01-03), and every cross-link between the guides resolves to a site page.
  - From now on, any push to `master` that changes a guide republishes the site.

### Staging housekeeping after the age-key rotation (2026-10-05)
- **Before shredding the retired VM age key (`age.key.prev-w4`)**, every backup on the VM was tested with the staging
  offline key alone.
  - The 9 backups from 2026-09-29 09:33 onward opened.
  - **The 3 older ones (09-27, 09-28, 09-29 02:37) did not.** They predate W2 adding the offline recipient, so only
    the retired key opened them; shredding it would have made them unreadable.
- **Fix:** those 3 backups (36 files) were re-encrypted on the VM to today's recipients (the current VM key + the
  offline key), exactly as `backup-postgres.sh` encrypts. Each file was checked against the original's plaintext
  before the swap, and the SHA256SUMS were rewritten. Downloaded to the dev PC: checksums verified, **all 36 files open
  with the offline key alone**.
- Then the retired key was shredded, and two stray files were removed from the backup root
  (`agent.sops.env.pre-unset-20260928`, `mediator-endorser-predrop-20260928.dump.age`; the latter was VM-key-only
  too). The backup root now holds dated backups only.
- **Lesson for the runbook:** before retiring a VM age key, check that the offline key opens every backup still kept,
  including those older than the offline recipient.
- **Owner:** `minisign.key.prev-w4` (keep offline or delete), and the staging offline key still on the dev PC
  (`E:\12id-credo\offline-keys`).

## v0.2.0: credential expiry as a date, and dependency security fixes (2026-10-06)

**Owner decisions (2026-10-06):**
- Expiry becomes a date.
- The mediator delete-before-send window is accepted.
- The hosting country is agreed per customer.

**`1c43365`: `expiresOn` replaces `expiresAt`.**
- The value is `YYYYMMDD` (UTC), accepted through the end of that day; every proof checks `expiresOn >= today`; any date up to 9999 works.
- It is a clean break: `expiresAt` is retired, and staging's old schemas no longer accept offers.
- The SDK reads `expiresOn` into the unchanged `expiresAtEpochSeconds` (0.2.1).

**New advisories found by CI.** The first push failed CI's `npm audit --omit=dev --audit-level=high`, on advisories published overnight:
- `proxy-addr`: critical, IP spoofing through Fastify's `trustProxy`;
- `fastify` 5.12.4: a moderate denial of service through HTTP/2 trailers;
- `fast-uri` and `valibot`: moderate;
- `source-map-js` (console): high.

Fixed in `5153935`: Fastify 5.12.5 plus lockfile updates. `v0.2.0-rc.1` was built before the fix and never deployed.

**Traps:**
- `npm audit fix --omit=dev` also prunes local dev dependencies. Run `npm install` afterwards.
- With C: full, point npm at E: (`npm_config_cache`, `TMP`/`TEMP`).

**Staging on `v0.2.0-rc.2`.** All seven stacks deployed from the rc.2 release file; rc.3's is kept as `release.env.prev-0.1.0-rc.3` for rollback.

| Check | Result |
|---|---|
| Deploy | no step failed; every container with a health check is healthy |
| Secrets in `docker inspect` | 0 of 32 |
| Monitoring targets | 22/22 up |
| Edge probes | as before |
| `smoke:platform-credo` | **PASSED**. The new schema is `smoke-badge 1.274250` with `expiresOn`; offer, credential and proof verified |
| `smoke:biometric-credo` | **18/18** |
| `e2e:staging` | **3/3** |
| `smoke:sdk-android` (phone, sample on SDK 0.2.1) | **PASSED, all steps**: expected offer in 3.0 s, 0 pickups in 60 s idle, foreground drain 2.5 s, tail 29.2 s with 1 wake-up, proof verified. Credentials carry `expiresOn: 20261105` |

The phone's USB link dropped repeatedly. The first phone run stopped at step 3b on "waiting for device"; the rerun passed. Its slower proof time (22.8 s) was first read as adb waits; it was the smoke's frozen receiver (see "After v0.2.0" below).

**Trap:** a smoke tunnel that dropped on the PC side (sleep) stays half-open on the VM and holds port 3200, so the next `-R 3200` fails. The owner killed the stale `sshd` session.

**Released:**
- `v0.2.0`, tagged on `5153935`, the same commit as rc.2. CI adds `0.2.0` to the rc.2 digests without rebuilding.
- `sdk-android-v0.2.1`.

## After v0.2.0: token bursts, M15, and production sizing (2026-10-06)

Nothing in this section is committed or released. SDK `master` is 0.3.0 in the working tree.

### The repeated wallet-token requests: the smoke's own receiver, not the SDK
**Symptom:** during `smoke:sdk-android` the stand-in customer backend issued tokens in bursts (four within 64 ms), 15 in one run.

**Cause:** `infra/smoke/sdk-android.ts` ran adb with `execFileSync`. One `adb logcat -d` takes 1–4 s on the phone, and the smoke calls it back to back, so the Node process that also serves the stand-in backend and the webhook receiver was frozen most of the time.
- The app's token request (the sample's OkHttp client, 10 s timeout) timed out; the SDK logged `biometric requirements unavailable` and asked again on the next call, one request at a time (13 timeouts, 10–15 s apart, never concurrent).
- When the event loop came free, the queued requests were answered together. Webhooks arrived in the same bursts, and the platform retried them (duplicates in the log).
- platform-api saw only the `POST /v1/wallets` calls in those windows and **no 401**. The SDK's single-fetch guard (`PlatformClient.walletToken`) works.

**Fix (smoke only):** adb is asynchronous in `sdk-android.ts` and `sdk-biometric-android.ts`.

| `smoke:sdk-android` on the phone | before | after |
|---|---|---|
| Token requests in the run | 15 | **3** (one per app process start) |
| App-side token timeouts | 13 | 0 |
| Duplicate webhooks | several | 0 |
| Proof request in the app | 22.8 s | **2.9 s** |
| Second offer by the sync tail | 29.2 s | 10.8 s |

The 22.8 s proof time recorded above for the `v0.2.0` run was this freeze, not the USB link.

**Two more harness races, fixed on the way:**
- **Screen wake.** The phone's screen slept and woke inside step 3b's idle minute; the app came back to the foreground and drained once (by design), and the step counted it. The smoke now keeps the screen on for the run (`svc power stayon`, restored afterwards) and names the pickup kinds when 3b fails.
- **MIUI autostart.** `pm clear` resets app-op 10008 some time later, not at once. One run lost that race and MIUI refused to start the killed app for the simulated push (`MIUIOP(10008): ignore`, `rejectTime`). `allowAutostart()` now runs after the clear and again before step 4, and fails loudly if the op cannot be set.

`sdk-biometric-android.ts` is converted and type-checks; it was not run on the phone.

### M15: the SDK checks the genesis file's minisign signature (SDK 0.3.0, not released)
**What changed:**
- `internal/Minisign.kt`: minisign verification (the prehashed `ED` format and the legacy `Ed`), a pure-Kotlin BLAKE2b-512 (RFC 7693), and Ed25519 through Askar, which the SDK already ships. No new dependency.
- `GenesisCache`: downloads the `.minisig` next to the genesis file and accepts the file only when one of the app's trusted keys signed it. The signature is stored beside the cached file and **checked on every start**, so a file cached by an older SDK is downloaded again. The sha256, the signature URL and the key in `/v1/ledger` stay hints.
- `OneTwoIdConfig.genesisPublicKeys: List<String>` (a third constructor, so 0.1.0–0.2.1 callers still link; the API dump differs by additions only). `initialize` refuses an empty or malformed list with `InvalidConfiguration`.
- The default is `PRODUCTION_GENESIS_PUBLIC_KEYS` in `internal/ApiBaseUrl.kt`, **empty until W5 generates production's keys**. Until then every app must name its environment's key. The sample passes staging's (`GENESIS_PUBLIC_KEY`, overridable with `-PgenesisPublicKey=`).
- `sdkVersion=0.3.0`.

**Verified:**
- `:sdk:testDebugUnitTest` and `testReleaseUnitTest` 84/84, `apiCheck` clean. New: `MinisignTest` (11) and `GenesisCacheTest` (11).
  - BLAKE2b against the RFC vectors and against Node's `blake2b512` on both sides of each block boundary.
  - **Staging's real genesis v2 and its published signature verify with staging's key**; a changed file, a changed trusted comment, an untrusted key, an impostor with the trusted key's id, and malformed signature files are refused.
  - A genesis signed by the platform's own (untrusted) key is refused and nothing is cached; no signature URL is refused; a legacy cache without a signature is fetched again; offline with a cached file signed by an untrusted key fails.
- **Phone (Xiaomi, Android 14), sample on 0.3.0 with staging's key: `smoke:sdk-android` PASSED, all steps.** The app's `no_backup/onetwoid/genesis/` holds the `.txn` and its `.minisig`.
- **Phone, the same build with another key (staging's key id, a different Ed25519 key):** `state=Failed LedgerUnavailable: the genesis signature is not from a trusted key`. Reinstalling the staging-key build: `wallet ready`.
- The first onboarding of that phone run failed once with `NetworkUnavailable` (one `GET /v1/ledger`, then nothing for 10 s, no stack trace in logcat, which is how Android logs an `UnknownHostException`). A relaunch 95 s later onboarded in 7 s. Read as a DNS failure on the phone's network; seen once.

**Left for the release (with W5):**
1. Put production's primary and backup public keys in `PRODUCTION_GENESIS_PUBLIC_KEYS`.
2. Add `genesisPublicKeys` to `sdk-android/docs/integration.md` (it still says "verified by checksum"). That file publishes to docs.12id.com on push, so it changes with the release, not before.
3. Tag `sdk-android-v0.3.0`.
Any SDK release cut from `master` before step 1 works only for apps that pass `genesisPublicKeys`.

### Production sizing: measured costs, and a defect that outweighs them
**Method.** `load/exchanges.ts` gained `--pickup v1 --poll <ms>` (holders ask the mediator with PickUpV1 batches every 1.5–2 s, like the SDK inside an exchange window), `--idle` (a polling-only baseline) and phase timestamps; it revokes its wallets at the end. CPU per container comes from the cgroup counters (`cpu.stat`) sampled every 5 s on the VM. Holders ran on the dev PC through the real edge, without a rate-limit exemption.

**Run 1 (5 holders, 4 min): 393 issuances, 1.64/s, 0 errors, offer → done p50 3.0 s, p95 3.2 s** (W4 A4 with 5 s polling: 15.4 s).

| Component | Quiet | At 1.64 issuances/s | CPU per issuance |
|---|---|---|---|
| agent-service (one process, serial) | 0.02 core | 0.51 | **298 ms** |
| agent Postgres (every service's database except the mediator's) | 0.02 | 0.22 | 116 ms |
| mediator, two replicas | 0.01 | 0.24 | 138 ms |
| mediator Postgres | 0.02 | 0.05 | 20 ms |
| platform-api | 0.02 | 0.09 | 38 ms |
| Caddy | 0.00 | 0.03 | 16 ms |
| **Total per issuance** | | | **about 0.63 core-seconds** |
| Monitoring stack | 0.16 | 0.16 | none |
| Four von-network validators | 0.82 | 0.75 | none |

- **Mediator:** about 33 ms of CPU per empty pickup at 4 pickups/s (W4: 22 ms at 20/s) and about 30 ms more per delivered message. A real SDK issuance is roughly 6 pickups and 2 messages, so about 0.26 core-seconds: one replica carries about 3.8 issuances/s, and replicas add up.
- **agent-service is the ceiling:** one serial process at 0.30 core-seconds per issuance tops out near **3.3 issuances/s (about 200 a minute)**, and more cores do not raise it.
- **Memory:** every 12id container together peaked at about 1.8 GB under load (agent Postgres 389 MiB, mediator Postgres 294, agent-service 271, each mediator 180), monitoring about 1.0 GB, the validators about 0.5 GB.
- **Storage:** the Askar store is 67 MB for about 9,800 records (about 7 KB a record, so roughly 30 KB per stored exchange with its three messages).
- Not measured: proofs, biometric checks, and rates above 1.6/s.

**The defect: an exchange gets slower as a tenant's history grows.**
- Run 2 (7 holders) started like run 1, then **stepped up within a minute at the same rate**: agent-service 0.5 → 0.95 core, its Postgres 0.2 → 0.7. Run 3, ten minutes later: **28 issuances a minute** instead of 98, no errors. A fourth run with 3 holders: offer → done p50 8 s.
- `agent_root` during run 3: `ix_items_tags_name_enc` took 431,560 scans and **454 million index rows for 94 issuances**, three times the index's whole previous history.
- The query is Askar's record scan with four or five encrypted tag conditions, each `i.id IN (SELECT item_id FROM items_tags WHERE name = $n AND value = $v AND SUBSTR(value, 1, 12) = $s AND plaintext = 0)`: Credo looking up a stored DIDComm message. In the smoke tenant's profile (3,489 message records) three of those tags hold one value on every record and two more hold three values; only one tag is unique.
- `EXPLAIN (ANALYZE, BUFFERS)` of that five-tag lookup on staging (read-only):

  | Plan | Time | Buffers | Shape |
  |---|---|---|---|
  | Generic (what a pooled connection's prepared statement settles on) | **5,421 ms** | 3.1 million | nested-loop semi-joins that rescan a 1,600–1,750-row tag range for each of 3,489 rows: quadratic in the tenant's stored messages |
  | Custom (planned for the values) | 43 ms | 52 thousand | still starts from a tag that matches all 3,489 rows: linear |

- The step in run 2 fits the pooled connections' cached plans changing (`items_tags` was auto-analysed during that run); the trigger itself was not captured.
- **Why it matters:** message records live as long as the exchange, and `RETENTION_DAYS` defaults to 90. A tenant reaches the smoke tenant's 1,160 exchanges at 13 a day. No VM size fixes a quadratic lookup.
- **Options, not yet tried:**
  1. `plan_cache_mode = force_custom_plan` for the agent's database role: the 5.4 s lookup becomes 43 ms here, for about 3–6 ms of planning per query. A setting, no code. It removes the quadratic plan and leaves the linear growth.
  2. Delete an exchange's stored DIDComm messages when it reaches `done` or `abandoned` (the platform already mirrors the state). This bounds the table by exchanges in flight, which is the real fix, and needs a check that nothing reads those messages later (the erase path already deletes them).
  3. Both.

**Also found by these runs:**
- **The edge's per-IP limits throttle the SDK's own polling.** `mediator_per_ip` is 300 a minute. Five holders polling every 1.5 s plus their follow-up pickups sent about 400 a minute and Caddy answered 170 a minute with 429 (`caddy_rate_limit_declined_requests_total`). The comment above the limit assumes one WebSocket per device; the SDK polls over https, every 1–2 s inside a window. A handful of phones behind one NAT, or one mobile carrier's shared address, reach it. `agent_per_ip` (300) is the same kind of limit.
- **One offer in about 770 was never collected** (run 2; the exchange stayed `offer-sent`, the holder timed out after 180 s). Cause not established. In the same run Caddy marked mediator replica 2 unhealthy twice for 30 s (its log is silent 10:40:29–10:40:59 and 10:43:31–10:44:01 with 0 restarts) and counted a few 502s; neither moment matches the lost offer's timestamp (10:42:38).
- **Webhook lag:** the `done` webhook arrived 3.5 s (p50) after the holder saw `done`.

**What this means for the production VM:**

| Peak load | VM |
|---|---|
| Up to about 1 issuance a second (3,600 an hour) | 4 vCPU, 8 GB |
| Up to the agent's ceiling, about 3 a second (10,000 an hour) | 8 vCPU, 16 GB |
| More than that | not a VM size: agent-service has to process in parallel or be split first |

Both rows include the ledger validators on the same VM (about 0.8 core idle on staging) and the monitoring stack, and assume the lookup defect is fixed. Disk: about 30 KB per retained exchange in the agent store, on top of images, backups and the ledger (staging uses 52 GB of 97).

**State left on staging by these runs:**
- The smoke tenant gained about 770 exchanges (22 load wallets, revoked), so its message lookups are slower than this morning. `smoke:platform-credo` still passed its functional checks in 43 s afterwards.
- The last short run had no webhook receiver, which left 56 deliveries queued for retry (backoff up to an hour, 12 attempts). A smoke run in that state reported `deliveries pending : 56` and 9 `BAD SIGNATURE` (events signed before its own secret rotation). A receiver then ran for 20 minutes and absorbed 77 events; the next `smoke:platform-credo` **PASSED** (42 s, all signatures valid, 0 pending).

## The slow message lookups: fix (2026-10-08)

**Status: released as `v0.2.1` on 2026-10-08** (commit `702925c`, the `-rc.1` digests). Staging runs `0.2.1-rc.1` and passed every smoke, the phone smoke included. Production deploys `release-0.2.1.env`.

The defect is the one in "After v0.2.0" above: a message lookup that gets slower with every message a tenant keeps, quadratic under Postgres's generic plan. The fix has two parts, and both are needed: the first removes the quadratic plan and leaves linear growth; the second bounds the table.

### Part 1: plan each Askar query for its values
- `infra/scripts/pg-roles.sh`, `agent()`: `ALTER ROLE agent_service IN DATABASE agent_root SET plan_cache_mode = force_custom_plan`.
- It is in `pg-roles.sh` because that script already runs after every restore and fresh provision, so a rebuilt VM gets it too.
- Scope: the Askar root store only. agent-service's own database, the endorser store and the mediator are untouched.
- Cost: about 3–6 ms of planning per query (measured 2026-10-06). It applies to new connections, so agent-service restarts once.

### Part 2: delete a finished exchange's stored messages
**The constraint.** platform-api reads the stored messages once more at the final state: `outbox-consumer.ts` calls `getProof` on `done` (the disclosed values come from the stored presentation) and `getCredential` on `abandoned` (the credential definition id comes from the stored offer). So the messages go only after the platform has acknowledged the final outbox row. `POST /outbox/ack` sets `outbox.delivered_at` after a whole batch is applied.

**agent-service:**
- Migration `0002_outbox_messages_purged`: `outbox.messages_purged_at`, and the partial index `outbox_purge_due_idx` over the rows that are due (credential or proof, final state, delivered, not purged).
- `src/exchanges/message-purge.ts`, shaped like `outbox-prune.ts`: every minute it reads the due rows in batches, opens one tenant session per tenant, deletes each record's messages (`DidCommMessageRepository.findByQuery({ associatedRecordId })`, the same lookup and delete as Credo's `deleteById(..., { deleteAssociatedDidCommMessages: true })`) and marks the row. The exchange record stays.
- A record or tenant that fails is logged and stays due; the run moves past it. One run at a time. A shutdown stops it between tenants.
- `MESSAGE_PURGE_INTERVAL_MS` (default 60 s, `0` = off). No compose change.
- The existing backlog drains by itself on the first start: every acknowledged final row still in the outbox (30 days) is due.

**platform-api,** `outbox-consumer.ts`: a replayed row never replaces a stored `credentialDefinitionId` or `disclosed` with an empty value from the agent. This matters only when rows are applied again after a platform database restore.

**Unchanged:** erasing a purged exchange works (the erase finds no messages); held biometric exchanges are not final, so their messages stay until they are released or abandoned.

**Accepted trade-off (owner, 2026-10-08, with the plan):** after a platform database restore, a proof that finished between the backup and the failure cannot get its disclosed values back from the agent. Its webhook was already delivered to the customer. Keeping the messages for a day to cover this would bring the slowdown back at production rates.

### Verified locally
- agent-service: `tsc` clean, **71/71** tests. New `message-purge.test.ts` (real Postgres, fake tenant wallets): only acknowledged final rows are purged; running, unacknowledged and connection rows keep their messages; a second run does nothing; a row acknowledged later is taken by the next run; an exchange with no messages is marked; a failing tenant or record does not block the others and stays due; a stop request ends the run between exchanges.
- platform-api: `tsc` clean, **104/104** tests. New consumer test: rows replayed after the purge keep the mirrored definition id and disclosed values.
- The purge query uses `outbox_purge_due_idx` (`EXPLAIN`, index-only scan).
- `pg-roles.sh` passes `bash -n`. The script itself was not run here; its new statement was run twice on Postgres 15.19 with a throwaway role (idempotent, and `pg_db_role_setting` shows `plan_cache_mode=force_custom_plan`).

### On staging (2026-10-08)
Load: `load/exchanges.ts --holders 5 --duration 120 --pickup v1 --poll 1000`, smoke tenant `b729f3a6…`, from the dev PC through the edge, with the webhook receiver.

| Run | Staging | Exchanges a minute | Offer → done p50 | p95 |
|---|---|---|---|---|
| Before | `0.2.0-rc.2` | 15.5 | 25.2 s | 32.2 s |
| Part 1 only (`pg-roles.sh agent`, agent-service restarted) | `0.2.0-rc.2` | 77 | 2.0 s | 30.1 s |
| Parts 1 and 2 | `0.2.1-rc.1` | 77 | 2.0 s | 29.4 s |
| Parts 1 and 2, `--poll 2000` | `0.2.1-rc.1` | 77.5 | 4.0 s | 4.2 s |

- **Before:** agent-service logged 43 `DidCommHttpInboundTransport` timeouts in the two minutes. After part 1: none.
- **The 30 s tail is the edge, not the agent.** The slow exchanges were exactly ten: all five holders at the start of the run and again one minute later. Caddy declined about 700 mediator requests in that run (`mediator_per_ip`, 300 a minute): five holders polling every second from one address use the whole budget, and all of them wait for the window. With 2 s polling it declined 12 and the tail is gone (the p50 is then the poll interval). This is the per-IP finding of "After v0.2.0", now with a number.
- **Throughput is bound by the five holders**, not by the agent, in every run after part 1.

**The purge against the real agent** (first start of `0.2.1-rc.1`):
- The backlog was 2,345 finished exchanges. One run deleted **6,829 stored messages in 37 s**, with no error or warning.
- The agent store went from about 9,900 records and 77,200 tags to **3,905 records and 15,739 tags**. The two large tenants went from 4,962 and 4,479 records to 1,473 and 1,475.
- After that it took each minute's finished exchanges: 17 to 78 a run during the load, 0 due at the end (2,664 purged in total).

**Checks on `0.2.1-rc.1`:**

| Check | Result |
|---|---|
| Deploy (seven stacks) | no step failed; every migration and provision job exited 0 (only the known harmless Askar "Duplicate entry" line); every container with a health check is healthy |
| Secrets in `docker inspect` | 0 of 32 |
| Monitoring | 22/22 targets up, no alert firing |
| `smoke:platform-credo` | **PASSED** (39 s): offer, credential, proof `verified=true` with its disclosed values, all signatures valid, 0 deliveries pending |
| A proof purged at 06:11 | still shows its disclosed values; erasing it through the API answered 200 |
| A credential purged a minute after `done` | erased through the API (200); a second erase is a no-op |
| An exchange erased before its purge | the purge found no messages and marked it |
| `smoke:biometric-credo` | **18/18** on the second run. The first run was 17/18 on "all signatures valid": the three `record.erased` events of the erase checks above belong to the other smoke tenant, were retried into this run's receiver (delivered 06:19:16 to 06:19:29) and carry that tenant's signature. Caused by the check, not by the release |
| `e2e:staging` | **3/3** |
| `smoke:sdk-android` (phone, sample on SDK 0.3.0 with staging's key) | **PASSED, all steps**, on the third run (07:04 UTC): expected offer in the app after 2.1 s, 0 pickups in 60 s idle, foreground drain 2.7 s, offline offer collected after one wake-up, second offer by the tail after 12.7 s, proof in the app after 1.8 s and `verified=true`, restart keeps 3 credentials, spent invitation recovered in 25 s, all signatures valid. The first two runs stopped at step 3c, both passing steps 1 to 3b first: see below |

**The two failed phone runs were the smoke's tunnel, not the release.**
- Both stopped on `timed out waiting for webhook` at step 3c, and both times the `-R 3200` SSH tunnel from the dev PC had ended with `Connection reset by peer`.
- Around the first drop (about 06:39 to 06:43 UTC) new SSH connections to the VM timed out and one HTTPS request did too; a ping run at 06:44 lost 3 of 20 packets. The VM itself was up the whole time, with no fail2ban ban of the PC's address and nothing in its SSH log.
- A network watcher ran through the third run (ping, the tunnel and `api` every few seconds): nothing failed, and the run passed. A tunnel left idle for 150 s with the phone untouched also stayed up.
- **Cause not established:** a disturbance on the path between the dev PC and the VM is what the measurements show. The same symptom was seen on 2026-10-06 and blamed on the PC sleeping.
- Each dropped tunnel left a half-open session on the VM holding port 3200; ending that `sshd: ubuntu` process (it belongs to the unprivileged user) frees it.

**Release:** `v0.2.1-rc.1` was built by CI in about 15 minutes; `v0.2.1` on the same commit adds `0.2.1` to its digests.

**Kept on the VM for a rollback:** `infra/compose/release.env.prev-0.2.0-rc.2` and `infra/scripts/pg-roles.sh.prev-20261008`. Migration 0002 only adds a column and an index, so `0.2.0` runs on the migrated database. To undo the role setting: `ALTER ROLE agent_service IN DATABASE agent_root RESET plan_cache_mode`.

**Still open:**
- Lookups still grow linearly with a tenant's exchanges in flight (offers waiting for a holder, up to the 24 h reconciliation TTL). Not measured: these runs had no waiting offers.
- The edge's per-IP limits (measured above) and the one uncollected offer of 2026-10-06.
- Why the smoke tunnel drops (above). It only affects the test rig.

## The edge's per-IP limits for phones (2026-10-08)

**Status: released as `v0.2.2`** (below). First applied on staging at about 08:10 UTC by copying the Caddyfile and `compose.edge.yml` there; the measurements in this section were taken then, on the `0.2.1-rc.1` images.

**What a phone costs** (edge counters during the passing phone smoke, the only client on the mediator and agent hosts at the time; 30 s scrapes, so about ±4):

| Minute of the run | Mediator requests | Agent requests |
|---|---|---|
| Onboarding, connect, first offer accepted | 56 | 8 |
| Process started by a push, two offers, sync tail | 64 | 20 |
| Whole run (2 onboardings, 5 offers, 2 proofs), 6 minutes | 131 | 22 |

The app logged 55 pickups in that run, so a pickup is more than one request at the edge.

**So the old limits were far too low.** `mediator_per_ip` was 300 a minute: about **5 phones a minute** onboarding behind one address (an office Wi-Fi, a carrier's NAT). `agent_per_ip` was 300 a minute as well. Both dated from Phase 1, when a holder kept one WebSocket open; since SDK 0.2.0 every pickup is an https request. And the window was one minute, so an address that used its budget was refused until requests a minute old left it: the 30 s stalls measured above.

**Change (`infra/compose/caddy/Caddyfile`, `compose.edge.yml`, `env/template.env`):**
- `mediator_per_ip`: **500 per 10 s** (3,000 a minute, about 50 phones a minute onboarding behind one address).
- `agent_per_ip`: **200 per 10 s** (1,200 a minute, 60 phones or more).
- The window for these two is 10 s, so a used-up budget clears in 10 s instead of a minute. The other zones (`api` 600, `console` 300, `vdr` 120 a minute) are unchanged.
- Both numbers are settings: `EDGE_MEDIATOR_LIMIT` and `EDGE_AGENT_LIMIT` in the environment file, with these defaults in `compose.edge.yml`. They will need tuning against real traffic, and a self-hoster's network is not ours.

**What it costs:** this limit was never what protects the mediator's capacity, and now it is clearly not. Two staging replicas handle about 80 requests a second (W4); one address may now use 50 of them. A flood from a few addresses was already enough at 300 a minute (16 addresses then, 2 now). What still stops junk is the 512 KB body cap and the mediator's own checks.

**On staging**, the same load as above (`--pickup v1 --poll 1000`, one address):

| Run | Exchanges a minute | Offer → done p50 | p95 | Declined at the edge |
|---|---|---|---|---|
| 5 holders, old limits | 77 | 2.0 s | 29.4 s | about 700 |
| 5 holders, new limits | **143.5** | 2.0 s | **3.0 s** | 0 |
| 20 holders, new limits | 169 | 7.3 s | 8.3 s | 0 |

- The old limits were also holding the 5-holder run to 77 a minute: with them gone it reaches 143.5. Those holders sent about 960 mediator and 450 agent requests a minute, both over the old 300.
- With 20 holders the agent's serial queue is the limit, as the sizing runs said (about 200 a minute); the 7 s is waiting there, not at the edge. The mediator took about 2,400 requests a minute from the one address.
- **No exchange was lost or left unfinished in these 625** (every one reached `done`), and none in the 494 of the earlier runs today.
- **The limit still works:** 900 requests in 0.9 s got 500 answers and 400 times 429 with `Retry-After: 10`; the next request passed 10.2 s after the burst began. `agent.` answered normally meanwhile.
- `caddy validate` passed on staging's own binary before the change; after it, the live config shows the five zones as intended, 22/22 targets are up and no service logged an error.

**Not tested:** how the SDK on a phone behaves when it does get a 429. Nothing in today's runs made a phone hit the limit.

**Noticed:** `api_per_ip` is 600 a minute, and the 20-holder run used about 400 from one address. A customer's backend calls the API from one address, with at least three calls per new user, so it reaches this limit at roughly the agent's own ceiling. Not changed.

**Kept on the VM for a rollback:** `/opt/12id/infra.prev-20261008-edge/` (the previous `Caddyfile` and `compose.edge.yml`); copy them back and run `deploy.sh edge up -d`.

### Released as `v0.2.2` (2026-10-08)
Commit `2a0c32c`. `v0.2.2-rc.1` was built by CI and deployed to staging from its bundle: the bundle's `compose/`, `scripts/` and `systemd/` matched the VM's tree file for file (the limits had been copied there by hand an hour earlier), so only `release.env` changed. `v0.2.2` on the same commit carries the rc's digests.

| Check on `0.2.2-rc.1` | Result |
|---|---|
| Deploy (seven stacks) | no step failed; every migration and provision job exited 0; every container with a health check is healthy |
| Secrets in `docker inspect` | 0 of 32 |
| Monitoring | 22/22 targets up, no alert firing |
| Live limits | `mediator_per_ip` 500 per 10 s, `agent_per_ip` 200 per 10 s; nothing declined during the smokes |
| `smoke:platform-credo` | **PASSED** |
| `smoke:biometric-credo` | **18/18** |
| `e2e:staging` | **3/3** |
| `smoke:sdk-android` (phone, sample on SDK 0.3.0 with staging's key) | **PASSED, all steps**, on the second run: expected offer after 2.2 s, 0 pickups in 60 s idle, foreground drain 2.8 s, proof in the app after 3.8 s and `verified=true`, restart keeps 3 credentials, spent invitation recovered in 26 s, all signatures valid. The first run stopped at 3b (`3b needs the app in the foreground`): an incoming WhatsApp call had taken the phone's screen |

**Kept on the VM for a rollback:** `infra/compose/release.env.prev-0.2.1-rc.1`, and the previous edge files in `/opt/12id/infra.prev-20261008-edge/`.

**Production deploys `release-0.2.2.env` and the `0.2.2` bundle** (the limits are in the bundle's Caddyfile and `compose.edge.yml`, not in an image).
