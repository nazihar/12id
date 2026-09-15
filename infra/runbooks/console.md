# Console (Phase 4) — deploy and operate

The console (`12id/console/`, TanStack Start + Better Auth) is the operator console and, from
stage 4b, the tenant portal, at `https://12id.naziharitsolution.com`. Its server calls platform-api's
**console scope** (`x-console-token` + actor/role/tenant headers) over the `12id-agent` network;
the browser only ever holds a Better Auth session cookie. Plan: `implement/11-phase-4.md`.

## Prerequisites on the VM (once)

1. **Secrets.** Generate tokens with `openssl rand -base64 33 | tr -d '/+='` (40 chars).

   | File | Key | Notes |
   |---|---|---|
   | `console.sops.env` | `BETTER_AUTH_SECRET` | signs sessions and encrypts TOTP secrets; rotating it signs everyone out |
   | `console.sops.env` | `CONSOLE_TOKEN` | **same value** as `platform.sops.env: CONSOLE_TOKEN` |
   | `console.sops.env` | `SMTP_URL` | `smtps://user:password@host:465` or `smtp://…:587`; URL-encode `@`, `/`, `:` in the password. Required: the console refuses to start in production without it |
   | `console.sops.env` | `MAIL_FROM` | optional; default `12id Console <no-reply@12id.naziharitsolution.com>`. Set it if the provider only sends from verified addresses |
   | `platform.sops.env` | `CONSOLE_TOKEN` | enables the console scope on platform-api; unset = scope disabled |

   Create or edit with `SOPS_AGE_KEY_FILE=/opt/12id/secrets/age.key sops infra/staging/secrets/<file>`
   (a new file needs `--filename-override infra/staging/secrets/console.sops.env` when created from
   a temp path, so `.sops.yaml`'s rule applies).

2. **DNS.** `12id.naziharitsolution.com A 123.176.58.72` (the wildcard does not cover the apex).

## Deploy order

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

Checks from outside: `https://12id.naziharitsolution.com/api/health` 200; `/` redirects to `/login`;
`https://api.12id…/v1/ledger` with header `X-Console-Token: x` → 404; `:3600` closed.

## First operator

```bash
cd /opt/12id
EXTRA_SECRETS=agent infra/scripts/deploy.sh console run --rm console-tools \
  npx auth create-admin --config src/server/auth.server.ts \
  --email you@example.com --password "$(openssl rand -base64 18)" --name 'Your Name' --role operator --yes
```

Then, in the console: "Forgot password" is not on the login page yet; use the temporary password,
and the console forces authenticator-app enrollment before anything else. Operators cannot use
emailed codes. Further operators are invited from **Operators** in the console (they receive a
set-password link; the link works once and expires in one hour).

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
- **Lost authenticator (members).** Same SQL as for operators below; members may also have chosen
  emailed codes, which recover through the mailbox.

## Operating notes

- **Break-glass.** `x-admin-token` on `/admin/*` over an SSH tunnel still works (see
  `platform-api.md`); every use is in the console audit log as actor `admin-token`.
- **Lost authenticator.** Backup codes were shown at enrollment. Without them, an operator disables
  2FA for the account directly in the `console` database (`update "user" set two_factor_enabled=false;
  delete from two_factor where user_id=…`) and the user re-enrolls at next sign-in. Record it in
  the ticket; there is no UI for it on purpose.
- **Rotate `CONSOLE_TOKEN`.** Change it in both sops files, then `deploy.sh platform up -d` and
  `deploy.sh console up -d`. Console calls fail with 401 between the two.
- **Rate limits.** Better Auth: sign-in 3 attempts / 10 s per IP, password-reset requests 3 / minute
  per IP; the edge adds 300 requests / minute per IP. Inviting many people at once from one office
  IP hits the reset limit (they can use the "expired link" path later).
- **Backups.** `console` is dumped by `backup-postgres.sh`; restore as for the agent databases.
  The dump contains TOTP secrets encrypted with `BETTER_AUTH_SECRET`; restoring under a different
  secret invalidates every enrollment.
- **Logs.** `deploy.sh console logs -f console`. Mail failures surface as Better Auth errors on the
  affected endpoint; the SMTP URL never appears in logs.
