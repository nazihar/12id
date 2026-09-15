# Phase 4 — Findings

**Plan:** [11-phase-4.md](11-phase-4.md). **Status: C1 (platform-api console scope) done locally, not yet deployed. C0 spike done: the auth path passes in a browser against a local platform-api.**

| Item | State |
|---|---|
| C1 console scope, audit, new routes | **done, local.** 34/34 platform-api tests (28 existing + 6 new), `tsc --noEmit` clean, migration `0001_console_audit`, both OpenAPI documents generated. Not deployed (C5) |
| C0 spike | **done.** Pinned stack installed; production runtime settled (`srvx`, no Nitro); Better Auth schema migrated; operator bootstrap, mandatory 2FA, operator TOTP-only, console scope from a server function and CSRF all proven in Playwright (2/2). Console: `tsc` clean, Vitest 9/9, client bundle clean |
| C2 console skeleton | **done:** auth pages (`/login`, `/verify-2fa`, `/setup-2fa`, `/reset-password`), `_authed` and operator layouts, middleware, typed platform client, DataTable (TanStack Table v9), shared components |
| C3 operator console | **done locally, Playwright 3/3.** Tenants list + create + detail (overview with console-organization creation and members, API keys, catalogue, templates, exchanges, wallets, webhooks with body view and retry), cross-tenant dead deliveries, audit log, operators (invite, ban/unban, sign out everywhere). Tenant creation could only be exercised up to platform-api's 502 locally (no agent-service); the audit row for it was written |
| C5 staging deploy (4a) | **done, 2026-09-14.** platform-api `12id/services:phase4` (console scope live, `console_audit` migrated); console `12id/console:phase4` behind Caddy at `https://12id.naziharitsolution.com` (Let's Encrypt, TLS-ALPN); `console` database migrated on agent-postgres; Gmail SMTP (staging credential, to rotate); blackbox probe; backups include `console`; first operator via the tools image |
| C6 staging checks (4a) | **passed:** `e2e:staging` (sign-in, operator TOTP enrollment, tenants/catalogue/webhooks from platform-api, invitation by mail); `smoke:platform-credo` **PASSED with an API key created in the console** (then revoked there; audit shows create 201 and delete 200 by the operator); `:3600` closed from outside; `api.` with `X-Console-Token` → 404; anonymous `/ops` → 307 to login |
| C4 tenant portal (4b) | **done locally, Playwright 4/4 in 2.1 min** (`portal.spec.ts`: owner onboarding by mail link, email-code 2FA, API key and webhook secret shown once, invitation → account → member, role limits, cross-organization denial, role change and removal effective on the next request). Console `tsc` clean, Vitest 11/11, client bundle clean. **Staging, 2026-09-15: redeployed; `staging.spec.ts`, `staging-apikey.spec.ts` and `staging-portal.spec.ts` pass** (agent-backed catalogue, template builder, exchanges; audit log shows actor emails) |
| Not yet exercised at runtime | the operator 12 h session cap; an invited member accepting through real SMTP on staging (proven locally with the mail outbox, and for owners/operators on staging by the owner's own session) |

Every claim below comes from a local run on 2026-09-14 or a registry/doc read on that date.

---

## C1 — platform-api console scope (done, local)

What was built (`services/platform-api/`):
- **Principals.** `TenantContext.principal` is `{ kind: 'apiKey', apiKeyId }` or `{ kind: 'console', actor, role }`. `requireTenantPrincipal` accepts an API key, or `x-console-token` + `x-console-actor` + `x-console-role` + `x-console-tenant`. A presented console token that is wrong, or presented while `CONSOLE_TOKEN` is unset, is a 401; it never falls back to another credential.
- **Operators.** `requireOperator` accepts the console with role `operator`, or the break-glass `x-admin-token`. Organization roles (`owner`/`admin`/`member`) get 403 on `/admin/*`.
- **Audit.** `console_audit` (actor, role, tenant, method, route pattern, status, request id). Written in `onResponse` for every mutating console or break-glass request and for reads that opt in (`config: { auditRead: true }`, set on `GET /v1/webhook/deliveries/:id` because the body carries credential attributes). Customer API-key traffic is not audited here. A failed audit write is logged, not surfaced (written after the response).
- **Routes.**
  - `POST/GET /v1/api-keys`, `DELETE /v1/api-keys/:id`: console principal only; an API key gets 403.
  - `GET /admin/tenants/:id`, `GET /admin/overview` (per tenant: exchange counts by state, wallets and keys active/revoked, dead deliveries, last activity), `GET /admin/webhook-deliveries` (cross-tenant), `GET /admin/audit`.
- **OpenAPI.** `openapi.json` (customer) now leaves out console-only and operator routes via `hiddenTag: 'console-only'`: 29 → 25 paths (the four `/admin/*` paths). `openapi.console.json` has all 35 paths and a `consoleToken` security scheme; the console's typed client is generated from it.
- **Edge.** `api.<domain>` answers 404 to any request carrying `X-Console-Token` (Caddyfile edited, not deployed).

### Findings
1. **A pre-existing test started failing on 2026-09-14 at 10:00Z.** `wake.test.ts` "delivers, retries with backoff…" pinned its clock to `2026-09-14T10:00:00Z` but inserted deliveries with the database's `now()`. Once real time passed 10:00Z, no delivery was due (`0 !== 2`). A test bug, not a dispatcher bug; fixed by inserting rows due at the injected clock. Baseline before any Phase 4 change was 27/28.
2. **Idempotency replays would have stored new API keys in plaintext.** The idempotency hook stores the full response body for 24 h. Routes can now opt out (`config: { idempotency: false }`); `POST /v1/api-keys` does, and a test checks no stored body contains `12id_sk_`. **Open, pre-existing:** `POST /v1/wallets` with an `Idempotency-Key` stores the plaintext `walletToken` in `idempotency_keys` for 24 h. Changing that alters Phase 3 replay behaviour customers may rely on; left for a decision.
3. **The Caddy `header X-Console-Token *` matcher is unverified** until `caddy validate` runs on the VM (C5).

---

## C0 — Spike (in progress)

### Versions resolved (npm registry, 2026-09-14)
| Package | Pin | Note |
|---|---|---|
| `@tanstack/react-start` | 1.168.54 | depends on `@tanstack/react-router` **exactly** 1.170.36, so the router is pinned to that |
| `@tanstack/react-query` / `-router-ssr-query` | 5.102.8 / 1.167.2 | |
| `@tanstack/react-table` | **9.2.4** | v9 is `latest`; shadcn's data-table recipe already targets v9 (`useTable`, `tableFeatures()`) |
| `@tanstack/react-form` | 1.33.5 | |
| `better-auth` | 1.7.4 | peers accept `drizzle-orm ^0.45.2`, `drizzle-kit >=0.31.4`, `pg ^8`, `@tanstack/react-start ^1` |
| Better Auth CLI | **`auth` 1.7.4** | the docs now say `npx auth`; `@better-auth/cli` is stale at 1.4.21 |
| `vite` / `@vitejs/plugin-react` | 8.3.0 / 6.1.1 | Start peers `vite >=7` |
| `tailwindcss` / `@tailwindcss/vite` | 4.3.3 | |
| `shadcn` | 4.21.0 | Base UI default (`@base-ui/react` 1.8.0) |
| `react` / `react-dom` | 19.3.0 | |
| `drizzle-orm` / `drizzle-kit` / `pg` / `zod` / `typescript` | same as `services/` | |
| `srvx` | 1.0.4 | candidate Node runtime for the production build |
| `vitest` | 5.0.0 | test runner for the console; the plain `node --test` rule (Phase 2 D6) exists because of Credo's dual CJS/ESM resolution, which the console never loads |

### Production server on Node: Nitro is beta only
The TanStack Start hosting guide runs a Vite build through the Nitro plugin (`nitro/vite`, `node .output/server/index.mjs`). **`nitro`'s only published release is `3.0.260903-beta`** (dist-tag `latest`). The same guide says Nitro is optional for Node: the server bundle exports a fetch handler that `srvx` or a custom server can run. The spike builds without Nitro first and inspects the output; Nitro is the fallback.

### Production runtime: srvx, no Nitro (confirmed, run)
- `vite build` without Nitro writes `dist/client` and `dist/server/server.js`. `srvx --prod -s ../client -p 3601 dist/server/server.js` served `GET /` with 200 (title rendered) and the CSS asset with 200. **Nitro (beta) is not used.**
- **The SSR bundle keeps dependencies external** (`import … from "better-auth"`, `"pg"`, `"drizzle-orm"`, `"nodemailer"` in `dist/server/assets/router-*.js`). The image needs production `node_modules` next to `dist/`, not only the build output.
- With a route importing `auth.server.ts`, `dist/client` contains none of `drizzle-orm`, `pg-pool`, `nodemailer`, `betterAuth(`, `drizzleAdapter`, `BETTER_AUTH_SECRET`, `CONSOLE_TOKEN`.

### TanStack Start API facts (installed 1.168.54)
- `createServerFn().validator(schema)`; `inputValidator` is deprecated.
- `getRequestHeaders`, `getRequest`, `setResponseHeader`, `setResponseStatus` come from `@tanstack/react-start/server`.
- Server routes: `createFileRoute(path)({ server: { handlers: { GET, POST } } })`. Request middleware may return a `Response`.
- The packages ship agent skill docs under `node_modules/@tanstack/*/skills`. The console follows `start-core/{auth-server-primitives, middleware, server-functions, execution-model}` and `router-core/auth-and-guards`: auth on every server function via middleware, route guards for UX only, same-origin check for non-GET requests in `src/start.ts`, `no-store` on authenticated responses, env read inside callbacks.

### Better Auth facts that shape the design (installed 1.7.4, source read)
1. **`emailAndPassword.disableSignUp` blocks `/sign-up/email` for every caller**, `auth.api.signUpEmail` from the server included.
2. **The admin plugin's `createUser` accepts a server call with no request and no headers** (it refuses a caller that sent headers without an admin session). Invitees' accounts are therefore created by a server function after it validates the invitation; sign-up stays disabled. The first operator comes from `npx auth create-admin --role operator`.
3. Accepting an organization invitation needs a signed-in user whose email matches the invitation.
4. **2FA is opt-in per user**; there is no global switch. The console middleware refuses sessions of users without `twoFactorEnabled`.
5. `twoFactor.enable({ method: 'otp' })` turns 2FA on immediately; the TOTP path needs a verified code first.
6. **At sign-in, `otp` is offered to every 2FA user as soon as `otpOptions.sendOTP` is configured; `totp` only to users with a verified secret.** Operator TOTP-only therefore needs two pieces of ours: an after-hook that deletes a session obtained through `/two-factor/verify-otp` by an operator, and middleware that requires a verified TOTP secret. An operator who asks for an OTP still receives the email (not a bypass).
7. Failed second-factor attempts lock the account by default (10 attempts, 15 minutes).
8. Generated schema: 9 tables (`user`, `session`, `account`, `verification`, `organization` with unique `platform_tenant_id`, `member`, `invitation`, `two_factor`, `rate_limit`); migration `0000_better_auth`, applied locally. Timestamps are without time zone (Better Auth's generator), unlike the services' `timestamptz`.
9. `auth.api.getSession` returns the organization plugin's `activeOrganizationId` on the session, which the tenant middleware uses instead of any id from input.

### Runtime checks so far (confirmed, run)
- **Console scope over HTTP.** A local platform-api (`CONSOLE_TOKEN` set, port 3510, own database `platform_api_console`) answered `GET /admin/overview` with console headers (`operator` role) with 200 `[]`. Its `/v1/health` was 503 only because agent-service was not running locally.
- **Operator bootstrap.** `npx auth create-admin --config src/server/auth.server.ts --role operator` created `operator@12id.test` with role `operator`, email verified, 2FA off, against the migrated local `console` database.
- **Console build and tests.** `tsc --noEmit` clean; Vitest 9/9 (roles and permissions, the data-boundary scan that fails on any `createServerFn` without operator/tenant middleware, the platform client's console headers and tenant pinning); `vite build` clean, client bundle free of server markers.

### Auth path in a browser: PASSED (Playwright, 2026-09-14, 2/2 in 37 s)
`npm run e2e` (`e2e/auth.spec.ts`) against `vite dev` with the local Postgres and the local platform-api (port 3510, `CONSOLE_TOKEN` set); a fresh operator per run from `npx auth create-admin --role operator`.

| Check | Result |
|---|---|
| `POST /` with `Origin: https://evil.example`, and with no `Origin` | 403 and 403 (`src/start.ts`) |
| Anonymous `/` | redirected to `/login` |
| Operator signed in without 2FA; then direct `/ops` | both land on `/setup-2fa` |
| Setup page for an operator | no "Email me codes instead" option; QR, key and backup codes shown |
| TOTP from otplib `generateSync({ secret })` | 2FA on, redirected to `/ops`, Tenants page rendered from platform-api's `/admin/overview` through `operatorMiddleware` and the console scope |
| Sign out, sign in, "Email me a code instead", real code from the mail outbox | **refused:** "operators must use an authenticator app" (the after-hook's 403); `/ops` afterwards redirects to `/login`, so no usable session was left |
| Next TOTP window, sign in with TOTP | `/ops` |

Proven by this run: mandatory 2FA through the middleware, operator TOTP-only enforcement (after-hook + middleware), invite-free operator bootstrap through the CLI, the console scope from a server function, and the same-origin write check.

**Framework warning seen during the run:** TanStack Start logs that server functions are not protected by its CSRF middleware and recommends `createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' })` in `src/start.ts`. The console's own check covers non-GET requests only; GET server functions (`getViewer`, `getTenantOverview`) were outside it. Addressed below.

### CSRF: TanStack Start's built-in middleware (confirmed, run)
Defining `src/start.ts` switches off the CSRF middleware Start installs by itself, and a hand-written origin check covered only non-GET requests. `src/start.ts` now registers `createCsrfMiddleware` (from `@tanstack/react-start`; implementation read in `start-client-core/dist/esm/createCsrfMiddleware.js`):
- **What it checks:** `Sec-Fetch-Site` must be `same-origin`; without it, `Origin` must match; without both, `Referer`; with none of the three the request is refused (403).
- **Filter:** every server-function call (`handlerType === 'serverFn'`, GET included) and every other non-GET request. Top-level GET page loads are not checked, because invitation and password-reset links arrive cross-site from email.
- **Origin:** a matcher function comparing with the public origin from `BETTER_AUTH_URL`, read per request. The default compares with the internal request URL, which differs behind Caddy. Without the variable, every check fails closed.

Re-run (2/2, 26 s): the dev warning is gone; `POST /api/auth/sign-in/email` with `Sec-Fetch-Site: cross-site` → 403; the same request with `same-origin` and a matching `Origin` reached Better Auth (`WARN [Better Auth]: User not found`) and was refused by it; the operator flow still passes with `getViewer` and `getTenantOverview` behind the check. Production build and client-bundle check clean.

### C3 — operator console (done locally, Playwright 3/3 in 1.3 min)
`e2e/ops.spec.ts` signs in with the TOTP secret `auth.spec.ts` stored for the run, then: dead deliveries and audit pages render; the operators table lists the signed-in operator as "you"; inviting an operator creates the account through `auth.api.createUser` (with the operator's session headers, so Better Auth's admin permissions apply) and the mail outbox holds a `/api/auth/reset-password/<token>` link; "New tenant" reaches platform-api, which answered **502** (agent-service is not running locally) and the page showed the error instead of crashing. `console_audit` holds `POST /admin/tenants 502 operator <actor>` for it and no tenant row was created.

Design points settled while building:
- **Tenant owners are created server-side.** `createTenantOrganization` refuses non-ready tenants and operator accounts as owners, creates the user with `auth.api.createUser` (no headers → system call), creates the organization with `auth.api.createOrganization({ userId })` (Better Auth treats a session-less call with `userId` as a system action, so `allowUserToCreateOrganization: false` still holds), and sends the owner a set-password link through Better Auth's reset flow, which creates the credential account on first use. Operators never become members.
- **`revokeSessionsOnPasswordReset: true`**, and the reset mail is worded for both a forgotten password and a first password.
- **Deterministic timestamps** (`formatDateTime`, UTC) avoid SSR/client hydration mismatches; `toLocaleString` would differ.
- **Proof pages show disclosed attribute *names* only**; values are personal data. Webhook delivery bodies (which carry them) load only when opened and platform-api audits each read.
- **The sign-out button is hydration-gated** like the forms: a pre-hydration click was a silent no-op in the first run.
- Better Auth's built-in rate limit on `/request-password-reset` is 3 per minute per IP (`api/rate-limiter/index.mjs`); inviting more than three owners or operators within a minute from one console instance will hit it. Not yet handled; noted for C5.

### Staging (4a): what the owner's own session showed (console logs + audit, 11:40–11:55 UTC)
The owner exercised the whole operator path by hand, and every step landed as designed:
- The invitation mail reached `onetwoidadmin@gmail.com` through Gmail SMTP; the set-password link was used (`GET /api/auth/reset-password/<token>` → 302 → `POST /api/auth/reset-password` 200), then sign-in and TOTP enrollment.
- That operator created tenant **Arad Workspace** (`POST /admin/tenants` 201, onboarded `ready` on the staging ledger), its console organization with owner `aradworkspace@gmail.com` (role `user`, member `owner`), and an API key (`POST /v1/api-keys` 201).
- The owner account set its password from the mailed link, signed in and enrolled 2FA with **email OTP** (`send-otp` 3.7 s including SMTP, `verify-otp` 200).
- **Reopening the already-used link gave `/reset-password?error=INVALID_TOKEN`** and the "expired or already used" message: one-time links behave as intended.

Deploy findings:
- **Compose passes an empty string for a missing secret** (`${SMTP_URL:-}`), which failed `z.url()`; the env schema treats blank as unset (unit test added). The console itself still refuses to start in production without `SMTP_URL`.
- **The Better Auth CLI loads the full auth config**, so the tools job runs with `NODE_ENV=development` (no SMTP needed to create an operator).
- **Tarball sync drops executable bits** on `infra/scripts/*.sh` (Windows `tar`); `chmod +x` after extracting.
- **Playwright wipes `test-results/` on every run**, including files a spec saved there; the staging TOTP secret was lost that way and the operator's 2FA had to be reset through the runbook's lost-authenticator path. Staging specs now keep state in the gitignored `.staging/`.

### C4 — tenant portal (done locally, Playwright 4/4)
What was built (`console/src/`):
- **Routes** `/t/$orgSlug/{catalogue, templates, exchanges, wallets, webhooks, api-keys, members}`; `/account` lists the user's organizations; `/invite/$invitationId` is the public landing page of an invitation mail.
- **Organization context.** The layout's `beforeLoad` calls `activateOrganization({ slug })` (session-only middleware): it checks membership in the console database and makes that organization the session's active one; a non-member gets 403 "You are not a member of this organization." Every portal server function runs `tenantMiddleware(permission)`, which reads the active organization and the member's role from the database on each call, so role changes and removals apply on the next request. Mutations also carry the `organizationId` the page was showing and are refused when it differs from the active one (a second tab switched organization).
- **Server functions** (`features/portal/*.functions.ts`): catalogue (publish schema with `expiresAt` always appended, publish credential definition, deprecate/reactivate), proof templates (create/update/delete, validated with the zod mirror of platform-api's template rules), connection invitation, read browsers, webhook (set/rotate/delete, deliveries, body, retry), API keys (list/create/revoke), members (invite, cancel, change role, remove). UI actions are hidden with `tenantCan(role, …)`, which uses the same access-control roles as the server.
- **Invitations.** `getInvitationPreview` and `createInvitedAccount` are the only new public server functions (listed with reasons in the data-boundary test). The account is created only for a pending, unexpired invitation whose email has no account, with `emailVerified: true` (the link reached the mailbox); the page then signs in and accepts through Better Auth. An existing account signs in and accepts. `onPasswordReset` marks the email verified too, so owners created by an operator can accept later invitations (`requireEmailVerificationOnInvitation`).
- **Shared panels** (`features/tenant-data/panels.tsx`): API keys, deliveries, exchange tables and wallets are the same components on the operator and portal pages, fed different server functions and permissions.

Local run (`e2e/portal.spec.ts`, against `vite dev`, local Postgres and platform-api): two tenants seeded `ready` in the local platform database (onboarding needs agent-service); the operator creates both organizations; owner A sets a password from the mailed link, enrolls email codes, opens the portal, creates an API key (`12id_sk_…` shown once) and a webhook endpoint (`whsec_…` shown once), invites a member; the invitee creates an account from `/invite/<id>`, enrolls email codes and sees only organization A; as `member` there is no create/rotate/invite control; organization B's URL answers "You are not a member of this organization."; promoted to `admin`, the member gets "Create API key" on the next page load; removed, the member is refused. The catalogue page showed platform-api's "upstream agent error" inside the portal layout (no agent-service locally).

Findings:
1. **Hydration trap, second form: controls outside a `<form>`.** A role `<select>` changed right after a reload showed the new role while no request was sent: before hydration there is no `onChange`, and hydration keeps the DOM value. Every portal/panel action button and the role select are now disabled until `useHydrated()`.
2. **Better Auth's sign-in limit is 3 requests per 10 s per IP** and is stored in the database, so it spans test files; `auth.spec.ts` now waits out the window before its third sign-in. Local runs all share one IP.
3. **A `RegExp` built from an email address** (`member+…@12id.test`) never matched its table row (`+` is a quantifier); row locators use `filter({ hasText })`. Playwright's config now sets `actionTimeout: 15_000`, so a stuck action names its locator instead of using up the test timeout.
4. **Staging redeploy (2026-09-14, 12:45–12:50 UTC).** `12id/console:phase4` rebuilt with the portal, migrate job exited cleanly, container healthy. Test owner `onetwoidadmin+acme-owner@gmail.com` created with console-tools `create-admin --role user` (no mail needed). First `staging-portal.spec.ts` run: the operator created the `acme-platform` organization with that owner; the owner enrolled TOTP; catalogue listed `smoke-badge` schema and credential definition; the template builder saved a `smoke-badge` template through platform-api's validation and deleted it; a connection invitation QR rendered from agent-service; wallets and deliveries loaded; an API key was shown once and revoked; members listed the owner. The audit log held every owner mutation (`POST /v1/api-keys 201`, `DELETE /v1/api-keys/:id 200`, `POST /v1/connections/invitations 201`, `DELETE /v1/proof-templates/:id 200`, role `owner`, tenant `b729f3a6`). The only failed assertion was the spec's own: it looked for the owner's email, but **the audit actor is the Better Auth user id**, unreadable for an operator. The audit page now resolves ids to account emails from the console database (id kept as tooltip and search term). After a second redeploy all three staging specs passed; the portal spec, rerun on its own after the workstation slept through the first attempt (8.3 h wall clock, test timeout exceeded), passed in 6.4 s with both accounts signing in by TOTP. The API key the key spec created was revoked afterwards through the same spec (`STAGING_REVOKE`).
5. **Catalogue data lives in agent-service** (`GET /v1/schemas` lists through the agent), so catalogue, template and exchange pages cannot run against a local platform-api alone; `staging-portal.spec.ts` covers them.

### Wallet tokens and idempotency (2026-09-15, fixed; closes C1 finding 2)
**Problem.** With an `Idempotency-Key`, `POST /v1/wallets` stored its full response, including the plaintext `walletToken`, in `idempotency_keys` for 24 h (and in that night's backup). Opting the route out like API keys would make a retry create a second wallet. Separately, the key was only written after the response, so two in-flight requests with the same key both executed.

**Decision (owner).** A user may have several wallets (one per device/installation), so nothing is unique per user. Customers send the app's **installation id** as `Idempotency-Key`; a retry returns the same wallet with a **new token** and revokes the earlier one, which nobody received.

**Change (platform-api).**
- The key is **reserved when the request arrives** (`idempotency_keys.completed_at` null while in progress). A concurrent request with the same key gets 409 `idempotency_in_progress` + `Retry-After: 1`; a reservation older than 60 s is taken over (crashed process); a 5xx releases the key so the retry runs as new. Migration `0002_idempotency_in_progress` makes `status_code`/`response_body` nullable, adds `completed_at` and backfills it for existing rows.
- Routes can store a redacted body and answer replays themselves (`config.idempotency: { store, replay }`). `POST /v1/wallets` stores the wallet without the token; a replay mints a new token for the same wallet (409 `wallet_revoked` if it was revoked since). `POST /v1/webhook/rotate-secret` opts out (a replay could return a superseded secret; rotating again is harmless). `PUT /v1/webhook` keeps plain replay: its secret is already stored in `webhook_endpoints` for signing.
- OpenAPI description of `POST /v1/wallets` and `docs/api.md` document the contract.
- Tests: platform-api 36/36 (new: in-progress 409, stale takeover, 5xx release; wallet replay with same id, new token, old token 401, second installation → second wallet, no `12id_wt_` stored, replay after revoke → 409).

**Staging (2026-09-15).** platform-api `12id/services:phase4` rebuilt; provision applied `0002` (the one existing row backfilled, 0 left without `completed_at`); healthy. Through the console scope on acme-platform: first `POST /v1/wallets` with a key 201; retry 201 `idempotent-replayed: true`, same wallet id, new token; old token → `GET /v1/wallet` 401, new token 200; stored row `201`, completed, no `12id_wt_`; after revoking the test wallet, the same retry → 409 `wallet_revoked`; no test wallet left active. (A first revoke attempt returned 400 because the check sent `content-type: application/json` on a body-less DELETE, Fastify's standard empty-JSON-body refusal; resent without it.)

Still open (separate follow-up): wallets created by a backend that retries **without** the header stay orphaned (token never delivered); a cleanup of never-connected wallets could revoke them.

### Restore drill of the `console` database (2026-09-15, passed)
Backup: nightly `20260915T023447Z` (`12id-backup.timer`), `agent-console.dump.age` checksum OK. Restored with `age -d | pg_restore --create` into a scratch `postgres:15-alpine` on an isolated network; no contact with the running stack.
- **Content.** 9 tables. The restore holds the state of 02:34 UTC: 4 accounts (two operators, `aradworkspace@gmail.com`, the acme test owner), 2 organizations (Arad Workspace, acme-platform), 3 `two_factor` rows. Live had since grown to 6 accounts, 4 organizations, 3 pending invitations (the owner's manual testing that morning), as expected.
- **Sign-in against the restored copy.** A throwaway `12id/console:phase4` container on the scratch network (`127.0.0.1:3690`, real `BETTER_AUTH_SECRET` from sops, no platform-api, no SMTP) answered `/api/health` 200. For `onetwoidadmin+acme-owner@gmail.com`: password sign-in 200 with `twoFactorRedirect`; wrong TOTP 401 `INVALID_CODE`; current TOTP 200 for that account, and a 7-day session row appeared in the restored database. So password hashes restore, and TOTP secrets decrypt with the secret kept in `console.sops.env`.
- Cleaned up afterwards; runbook section added to `infra/runbooks/backup-restore.md`. (The drill script's own `get-session` call returned nothing because it forwarded the empty session cookie the sign-in step sets alongside the real one; the database row is the evidence used.)

### Bug found by manual testing (2026-09-15): concurrent tenant onboarding
**Symptom.** Creating a tenant from the console showed "Onboarding is failed: agent-service POST /tenants/<id>/onboard failed with HTTP 500"; "Retry onboarding" never recovered. All three tenants created that morning ("Test Phase 4", "Test Org", "Test Co 1") failed; the tenants of 2026-09-13/14 are `ready`.

**Cause (logs, ledger and databases on staging).** agent-service's `POST /tenants` starts `onboardTenant` in the background, and platform-api's `POST /admin/tenants` calls `POST /tenants/:id/onboard` a few milliseconds later. Nothing serialized the two runs:
1. both runs were in `pending` and each created a DID in the tenant wallet (`did_created` logged twice, 15 ms apart);
2. run A bound its nym `TCrG…` at the endorser; run B had overwritten the row with its nym `5HGx…`, its bind was refused (409 "tenant is already bound to a different nym") and it stopped;
3. run A got its own NYM request endorsed, reloaded the row (now B's DID) and submitted the endorsed request, which wrote **A's** NYM, then advanced to `nym_written`;
4. the check reads B's nym, which is not on the ledger, so every retry fails with "NYM … not found on the ledger".

Ledger: `TCrGSiYA3mNfnpvtQgxcFQ` present, `5HGxPwwUpujwwA9bwA2oGN` absent. Endorser bindings for the other two tenants likewise name a different nym than agent-service's row. Earlier tenants won the race by timing.

**Fix (agent-service).** `onboardTenant` joins a run already in flight for the same tenant (`singleFlight`, unit-tested), and each transition is a compare-and-set on the status the run read (`update … where status = <from>`), raising `OnboardingConflictError` instead of overwriting when another run moved the row. agent-service runs as one instance on staging; the compare-and-set also stops a second instance from corrupting the row. Typecheck clean, 43/43 tests.

**Verified on staging (05:03 UTC).** Agent stack rebuilt and restarted (healthy). `POST /admin/tenants` "Onboarding fix check 2026-09-15" answered 201 with status `ready` and DID `7z1vuPtFhbiVPAe1N9Z9hU`; agent-service logged each transition exactly once (`did_created`, `nym_endorsed`, `nym_written`, `ready`) even though both callers still start onboarding.

**Not recovered automatically.** The three affected tenants have a row DID that was never written and a wallet holding a second DID; they hold no data. Their fate is an owner decision.

### Trap: a form clicked before hydration submits the password in the URL (confirmed, run)
The first Playwright run clicked "Sign in" before React hydrated the page. The `<form>` had only a React `onSubmit`, so the browser performed a native **GET** submit: the URL became `/login?email=operator%2B…%4012id.test&password=E2e-Operator-…`. On a slow connection a real user does the same, and the password lands in browser history, proxy and access logs and `Referer` headers.

Fix on every auth form (login, verify-2fa, setup-2fa): `method="post"`, so a pre-hydration submit never builds a query string, and submit buttons disabled until `useHydrated()` (TanStack's documented hydration hook). Playwright's click waits for the enabled button, so the test needs no sleep. **Rule for every later console form: `method="post"` and hydration-gated submit.** A second hardening to consider: `Referrer-Policy: no-referrer` is already sent by `src/start.ts`.

### Client bundle: what the check looks for
- A first scan for secret *names* flagged `BETTER_AUTH_SECRET` in `dist/client/assets/auth-client-*.js`. It is Better Auth's isomorphic env helper (`@better-auth/core/dist/env/env-impl.mjs`): an object of getters, one named `BETTER_AUTH_SECRET`, whose reader is `{}[name]` in the browser build, so it returns `undefined`. The same chunk contained none of `internalAdapter`, `createAuthEndpoint`, `createAuthMiddleware`, `drizzleAdapter`, `symmetricEncrypt`, `hashPassword`, `sendMail`, `DATABASE_URL`, `process.env`. Not a leak.
- `scripts/check-client-bundle.ts` (`npm run check:client`) therefore looks for server *code*: Better Auth server internals, `drizzle-orm/node-postgres`, `pg-pool`, `nodemailer`, `appendFileSync`, `x-console-token`. Clean on the build with login, 2FA and operator pages that import server functions.

### shadcn init (4.21.0)
- Presets are `nova, vega, maia, lyra, mira, luma, sera, rhea`; `-p base-nova` is rejected even though `--help` names it. `init -t start -b base -p nova` wrote `components.json` with style `base-nova`, `src/lib/utils.ts`, a button and the theme in `app.css` (Geist variable font).
- **init adds caret ranges** (`@fontsource-variable/geist`, `shadcn`) and a dependency named **`cn`**. `cn` was checked before anything else was installed: maintainer `shadcn <m@shadcn.com>`, repository `github.com/shadcn-ui/cn`, MIT, no install scripts; `src/lib/utils.ts` is `export { cn } from "cn"`. The npm name dates from 2013, so it was transferred; maintainer and repository match shadcn, so it stays. Every range the CLI writes is re-pinned to the installed version after each `init`/`add`.

### Deliberate deviation from the TanStack guidance
`auth.server.ts` reads env at module scope: the Better Auth CLI (`generate`, `create-admin`) discovers a module-level `auth` instance. Acceptable here because the console runs on Node (not an edge runtime, where module-scope env is undefined) and `.server.ts` import protection fails production builds that would pull the file into the client.
