# Console (Phase 4) — deploy and operate

> **Phase 9 W2 (2026-09-29): commands below are from the original rollout.** Today every stack deploys with
> `infra/scripts/deploy.sh <stack>` (`ENV=staging` by default): no `EXTRA_SECRETS` (each compose file mounts
> the secrets it needs, from any stack's file) and no `--build` (images come from `infra/compose/release.env`;
> nothing is built on a VM). Secrets live in `infra/env/<env>/secrets/*.sops.env` and reach containers as
> files under `/run/secrets`; change one with `infra/scripts/set-secret.sh`, then redeploy the stack.
> The compose files are in `infra/compose/`, the staging-only parts in `infra/env/staging/`.
> See [production-bringup.md](production-bringup.md).

The console (`12id/console/`, TanStack Start + Better Auth) is the operator console and, from
stage 4b, the tenant portal, at `https://12id.naziharitsolution.com`. Its server calls platform-api's
**console scope** (`x-console-token` + actor/role/tenant headers) over the `12id-agent` network;
the browser only ever holds a Better Auth session cookie. Plan: `implement/11-phase-4.md`.

## Prerequisites on the VM (once)

1. **Secrets.** Generate tokens with `openssl rand -base64 33 | tr -d '/+='` (40 chars).

   | File | Key | Notes |
   |---|---|---|
   | `console.sops.env` | `BETTER_AUTH_SECRET` | signs sessions and encrypts TOTP secrets; rotate it only as in [key-rotation.md](key-rotation.md#console-auth-secret) (everyone signs in again, 2FA enrollments are kept) |
   | `console.sops.env` | `CONSOLE_TOKEN` | **same value** as `platform.sops.env: CONSOLE_TOKEN` |
   | `console.sops.env` | `SMTP_URL` | `smtps://user:password@host:465` or `smtp://…:587`; URL-encode `@`, `/`, `:` in the password. Required: the console refuses to start in production without it |
   | `console.sops.env` | `MAIL_FROM` | optional; default `12id Console <no-reply@12id.naziharitsolution.com>`. Set it if the provider only sends from verified addresses |
   | `platform.sops.env` | `CONSOLE_TOKEN` | enables the console scope on platform-api; unset = scope disabled |

   Create or edit with `SOPS_AGE_KEY_FILE=/opt/12id/secrets/age.key sops infra/staging/secrets/<file>`
   (a new file needs `--filename-override infra/staging/secrets/console.sops.env` when created from
   a temp path, so `.sops.yaml`'s rule applies).

2. **DNS.** `12id.naziharitsolution.com A 123.176.58.72` (the wildcard does not cover the apex).

## Deploy order

**Since Phase 7 (H2/H3, `postgres-roles.md`)** the console connects as its own role (`CONSOLE_DB_PASSWORD` in
`console.sops.env`) and needs no `EXTRA_SECRETS`; the platform stack needs only `EXTRA_SECRETS=biometric`.
The commands below are the original Phase 4 rollout.

```bash
cd /opt/12id
# 1. platform-api with the console scope (image tag phase4; provision applies migration 0001_console_audit).
EXTRA_SECRETS="agent mediator" infra/scripts/deploy.sh platform up -d --build
# 2. console: builds 12id/console:phase4 (npm ci in the image; slow on the 1 MB/s downlink), migrates, starts.
EXTRA_SECRETS="agent" infra/scripts/deploy.sh console up -d --build
# 3. edge: new apex site + the X-Console-Token block on api. RECREATE, never reload, after syncing the Caddyfile.
infra/scripts/deploy.sh edge up -d --force-recreate caddy
# 4. monitoring picks up the new blackbox target after a Prometheus restart.
EXTRA_SECRETS=mediator infra/scripts/deploy.sh monitoring up -d --force-recreate prometheus
```

**Syncing the tree to the VM: never let it touch `infra/staging/secrets/`.** The committed `*.sops.env`
files can be older than the VM's (`CONSOLE_TOKEN` was added to `platform.sops.env` on the VM); a
tarball extracted over `/opt/12id` replaced it and the next platform deploy failed at interpolation
(4-init trap 45). Exclude that directory, or commit the VM's file first. Until `platform.sops.env` on
the VM has `CONSOLE_TOKEN` again, the platform stack deploys with `EXTRA_SECRETS="agent mediator console"`.

Checks from outside: `https://12id.naziharitsolution.com/api/health` 200; `/` redirects to `/login`;
`https://api.12id…/v1/ledger` with header `X-Console-Token: x` → 404; `:3600` closed.

## First operator

```bash
cd /opt/12id
infra/scripts/deploy.sh console run --rm console-tools \
  npx auth create-admin --config src/server/auth.server.ts \
  --email you@example.com --password "Tmp-$(openssl rand -hex 12)-Q7!" --name 'Your Name' --role operator --yes
```

The password must pass the console's rules (implement/24; the command refuses one that does not, and the
random middle can, rarely, hold a sequence such as `abcd`: run it again). Then, in the console: sign in
with the temporary password (or use **Forgot your password?** on the login page, which emails the same
set-password link), and the console forces authenticator-app
enrollment before anything else. Operators cannot use
emailed codes. Further operators are invited from **Operators** in the console (they receive a
set-password link; the link works once and expires in 10 minutes, after which they use **Forgot your
password?** or an operator sends a new one from the row's **Send password link**).

## Tenant portal (stage 4b)

- **Giving a tenant its portal.** Operators → tenant → Overview → "Create organization" (tenant must be
  `ready`). A new owner email gets a set-password link; an existing non-operator account becomes owner
  without mail. Operator accounts cannot own an organization, and operators never join one.
- **People.** Owners invite from **Members** (`/t/<slug>/members`): the invitee gets `/invite/<id>`
  (48 h), creates an account there or signs in, and must set up 2FA (authenticator app or emailed
  codes). Roles: `owner` everything; `admin` API keys, webhook, catalogue, templates; `member`
  read-only. Role changes and removals apply on the member's next request.
- **A test owner without mail** (staging only): `console-tools` `npx auth create-admin … --role user`,
  then make that email the owner in the console. `console/e2e/staging-portal.spec.ts` uses one.
- **Automation operator** (staging only): `onetwoidadmin+e2e-operator@gmail.com`, role operator, created
  the same way on 2026-09-17 for `npm run e2e:staging`; its password and TOTP secret live in the
  workstation's gitignored `console/.staging/`. Ban it from **Operators** if that workstation is lost.
- **Lost authenticator (members).** Same SQL as for operators below; members may also have chosen
  emailed codes, which recover through the mailbox.

## Operating notes

- **Sign-in rules** (implement/24-console-sign-in.md; MTB Section 2). One policy for every account, set
  per deployment in the environment file (`CONSOLE_*`, defaults in `infra/env/template.env`), then
  `deploy.sh console`:
  - **Idle timeout** 15 minutes (`CONSOLE_IDLE_TIMEOUT_MINUTES`): only a person's pointer or key
    counts, and a dialog warns 2 minutes before. Staff keep the 12 h and others the 24 h cap from
    sign-in. Closing the browser ends the session (no remembered cookie).
  - **One session per account:** a completed sign-in (after the second factor) ends the others.
  - **Passwords:** 12 characters or more with upper and lower case, a digit and a symbol; no
    sequences, repeats, own name or common words; not one of the last 3; a meter on every form.
    Changed after 90 days (`CONSOLE_PASSWORD_MAX_AGE_DAYS`): until then every page sends the
    person to **Change password** (also in the account menu).
  - **Lock:** 5 wrong passwords in a row lock the account for 15 minutes
    (`CONSOLE_LOCK_THRESHOLD`, `CONSOLE_LOCK_MINUTES`), with a growing delay from the first. Operators
    unlock from Operators (**Unlock**), owners from Members. The lock after 10 wrong second
    factors is Better Auth's own and lifts by itself after 15 minutes.
  - **Captcha:** a proof of work on the sign-in and forgot-password forms (ALTCHA, self-hosted, no
    internet access needed).
  - **Reset links** last 10 minutes; an account with an authenticator app also gives its code on
    the reset page, and a wrong code spends the link. Operators and owners can mail a link from
    the row (**Send password link**).
  - **Unused accounts:** no sign-in for 90 days (`CONSOLE_INACTIVITY_DAYS`) disables the account
    (ban reason `inactive: …`) and mails a notice, checked hourly. Operators re-enable from
    Operators (**Re-enable**; held where `OPERATOR_APPROVALS=on`, like an unban), owners from Members.
    If every operator is disabled, create one with console-tools (First operator, above). In the
    database: `update "user" set banned = false, ban_reason = null, last_sign_in_at = now() where email = '…';`
    (and `failed_sign_ins = 0, locked_until = null` for a lock).

- **Break-glass.** `x-admin-token` on `/admin/*` over an SSH tunnel still works (see
  `platform-api.md`); every use is in the console audit log as actor `admin-token`.
- **Roles of the operator area** (implement/22 C14). An **operator** runs the platform. An **auditor**
  sees every page an operator sees and can change nothing: no button is offered, the console's server
  functions refuse it, and platform-api answers 403 to anything but a read. Personal data stays masked
  for an auditor, with no reveal. Both use an authenticator app and have 12 h sessions. Add either from
  Operators → Add operator; change the role from the row's Edit action.
- **Deleting an account.** Operators → Delete removes the account, its sessions and its 2FA setup for
  good. What it did stays in the audit log under its e-mail address. To block access and keep the
  account, ban it instead. Nobody can edit, ban or delete their own account, so an operator always
  remains; if the last one is lost anyway, create one with console-tools (First operator, above).
- **The audit log is append-only** (platform-api migration `0012`). A trigger refuses `UPDATE`,
  `DELETE` and `TRUNCATE` on `console_audit` and `erasures`. It also holds sign-ins, failed sign-ins,
  account changes and exports, which the console reports to platform-api. Removing a tenant row that
  has erasure entries is a deliberate act by the database owner (drop the trigger, delete, recreate
  it), to be decided and recorded.
- **The audit log's period** (implement/22 C15, migration `0014`). Audit rows are deleted when they
  are older than a period: `AUDIT_RETENTION_DAYS` in the environment file for the deployment (default 730;
  365 to 3650, or 0 to keep everything; platform-api refuses to start on another value; in the 0.5.0
  bundle it could only be set with a compose overlay), or an organisation's own
  period, set on its Data protection page. The pass runs with the sweep (`SWEEP_INTERVAL_MS`) and
  leaves one audit row ("Old audit entries deleted") per organisation it deleted from. Sign-ins and
  rows of no organisation follow the deployment's period. The erasure log is never deleted.
- **Approval by a second person** (implement/22 C17–C19). An organisation's owner or admin switches it
  on from Approvals in the portal (it needs two people with one of those roles); from then on a fixed
  list of changes waits until someone other than the person who asked approves it. The list is on
  the page; what only closes access (revoke, remove, ban) never waits. A request expires after 7
  days. Switching it off is itself a change that waits. For operator accounts (add, change role,
  unban) the switch is `OPERATOR_APPROVALS=on` in the environment file, then `deploy.sh platform`; have
  two operators first, because nobody approves their own request. If a deployment is left with one
  operator while it is on, set it to `off` and deploy: that is a server change, made by whoever runs
  the server. The break-glass admin token is not held and decides no request.
- **System health** (implement/22 C16). Operators and auditors open it from the sidebar. It shows
  what platform-api can reach, the alerts monitoring reports, and the non-secret settings the
  deployment runs with. Alertmanager pushes its notifications to platform-api
  (`POST http://127.0.0.1:3500/internal/alerts`); the console never talks to Prometheus or
  Alertmanager. It needs one secret, once:
  `infra/scripts/set-secret.sh monitoring ALERT_WEBHOOK_SECRET --generate`, then `deploy.sh platform`
  and `deploy.sh monitoring` (the platform stack mounts the monitoring stack's file). Without the
  secret the page says "monitoring is not connected". If it says "monitoring has stopped reporting",
  the heartbeat (`Watchdog`, every five minutes) is not arriving: check that Prometheus and
  Alertmanager are up (`deploy.sh monitoring ps`) and Alertmanager's log for a refused notification
  (it repeats one every minute while platform-api answers 401 or 404).
  To rotate the secret, generate it again and deploy both stacks; alerts sent between the two
  deploys are refused and repeated by Alertmanager within the hour.
- **Lost authenticator.** Backup codes were shown at enrollment. Without them, an operator disables
  2FA for the account directly in the `console` database (`update "user" set two_factor_enabled=false;
  delete from two_factor where user_id=…`) and the user re-enrolls at next sign-in. Record it in
  the ticket; there is no UI for it on purpose.
- **Rotate `CONSOLE_TOKEN`.** `set-secret.sh platform,console CONSOLE_TOKEN --generate` writes the same
  value into both sops files; then `deploy.sh platform` and `deploy.sh console`. Console calls fail with
  401 between the two ([key-rotation.md](key-rotation.md)).
- **Rate limits.** Better Auth: sign-in 3 attempts / 10 s per IP, password-reset requests 3 / minute
  per IP; the edge adds 300 requests / minute per IP. Inviting many people at once from one office
  IP hits the reset limit (they can use the "expired link" path later).
- **Backups.** `console` is dumped by `backup-postgres.sh`; restore as for the agent databases.
  The dump contains TOTP secrets encrypted with `BETTER_AUTH_SECRET`; restoring under a different
  secret invalidates every enrollment.
- **Logs.** `deploy.sh console logs -f console`. Mail failures surface as Better Auth errors on the
  affected endpoint; the SMTP URL never appears in logs.
