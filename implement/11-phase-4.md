# Phase 4 — Console (operator console + tenant portal)

## Context
Phases 0–3 run on staging (`12id/implement/1…10`). Customers can do everything through `https://api.12id.naziharitsolution.com` with an API key. People still have no UI:
- Operators create tenants and API keys over an SSH tunnel with `x-admin-token` (`services/platform-api/src/http/routes/admin.ts`).
- Customer staff have only the REST API.

4-init §10 Phase 4 lists: tenant management, catalogue (both identifier forms), a proof template builder with the expiry predicate enforced, connection and credential browsers, and a webhook delivery log.

The product will be **SaaS, and also self-hostable**. SaaS needs two kinds of user: 12id operators across all tenants, and customer staff limited to their own tenant. A self-hosted install needs only the operator role. Outcome: one console app with two roles, delivered in two stages, both verified on staging.

## Decisions (this session)
| Item | Decision | Consequence |
|---|---|---|
| Audience | **One app, two roles:** platform operator (all tenants) and tenant member (own tenant only) | Stage **4a**: operator console. Stage **4b**: tenant portal on the same app |
| Self-host | **Console-ready only** | No dependency on Google, our IPs or our VM; everything is configured by env. Packaging the whole stack for self-hosters is a later phase. New 4-init §12.15 |
| Stack | **TanStack Start (full stack) + Better Auth** | Server functions are the only caller of platform-api; the browser holds only a Better Auth session cookie |
| Auth | Better Auth with plugins `organization` (tenant membership, roles, invitations), `twoFactor`, `admin` (operator role, bans, session revocation) | Accounts come only from invitations or an operator bootstrap script (tenant onboarding writes the ledger, so there is no open sign-up) |
| 2FA methods | **TOTP (authenticator app) or email OTP** (`twoFactor` `otpOptions.sendOTP`), plus backup codes. **Required for everyone**, enforced by our middleware (Better Auth 2FA is opt-in per user) | **Operators: TOTP required, email OTP not allowed, no trusted devices.** If someone controls an operator's mailbox, password reset + email OTP collapse into one factor. Tenant members may choose either method; trusted device 30 days allowed |
| Console → platform-api | **New internal console scope:** `x-console-token` + `x-console-tenant` + `x-console-actor` | The existing `/v1/*` routes work unchanged; the console never sees customer API keys; every console call is audited |
| UI | **shadcn/ui + Tailwind v4** (Base UI primitives, the shadcn default since July 2026), lucide-react icons, sonner toasts | Components are copied into `src/components/ui` and owned by us; per-deployment theming via CSS variables (self-host rebranding) |
| Client packages | **TanStack Query** (router SSR integration), **TanStack Table**, **TanStack Form** + zod, `qrcode` | One ecosystem with Start; zod schemas shared by forms and server-function validators |
| UI revamp (C7, 2026-09-17) | **One shell** (shadcn `sidebar` with a workspace switcher as its top item, header with breadcrumb, theme toggle and profile menu), **one form kit** (TanStack Form + shared zod schemas + shadcn `Field`, validated on submit then live, `noValidate`), **short forms in dialogs, only the template builder on routes**, **every state-changing action behind one `ConfirmDialog`**, **row actions as icon buttons with a tooltip label**, **`Combobox` wherever a `<select>` was**, light/dark/system theme | The reference (shadcnuikit dashboard) was mined for ideas only. No portal overview page at the time (kept the redirect to Catalogue; C8 adds one); all e2e selectors follow the dialogs |
| Dashboards (C8, 2026-09-17) | **`/ops` becomes the operator dashboard** (tenants table moves to `/ops/tenants`); **`/t/$orgSlug` becomes the tenant Overview** (was a redirect to Catalogue); the same tenant dashboard is reused on `/ops/tenants/$tenantId`. Data from two new **console-scope-only** platform-api routes, `GET /v1/stats` and `GET /admin/stats` (counters, a 7/30/90-day series, attention lists, readiness checks). Charts with **shadcn `chart` + recharts**; a validated categorical palette replaces the preset's grayscale `--chart-*` tokens | Customer `openapi.json` unchanged (25 paths); `openapi.console.json` 35 → 37. Migration `0003_stats_indexes` on the mirror tables also delivers the index half of review finding L3. No agent-service call inside the stats routes (trap 44) |
| Lists (C9, 2026-09-24) | **Every list is paged on the server:** page numbers with a total, the `{ items, total, page, pageSize }` envelope on every list route (customer `/v1` included; `limit` removed), fixed `created_at desc` order, search and filters in the URL, external-id search as a case-insensitive contains on `pg_trgm` | A breaking change to the `/v1` list shape, accepted pre-production. Migration `0007_list_indexes`. Closes review L3 |
| Data access | **The console never reads `platform_api` or agent databases** | Response stripping, validation and audit stay in platform-api |
| Customer API keys | Stay in platform-api (sha256 table). The console only manages them through new routes | Better Auth's api-key plugin is **not** used |
| Storage | Better Auth tables in their own database `console` on `agent-postgres` | platform-api migrations stay separate |
| Packaging | `12id/console/`, a **separate package, lockfile and image**, outside the `services/` npm workspace | Vite and React dependencies never enter the Credo image (tsx/dual-module lesson, 4-init §7.1) |
| Email | **`SMTP_URL` required in production-like environments** (nodemailer): email OTP, invitations and password reset all send mail. In `NODE_ENV=development` only, mail is written to the log | Staging needs a provider before 4b (owner picks one; Gmail app password acceptable for staging only) |
| Hostname | **`12id.naziharitsolution.com`** (apex of the staging zone) | **Owner action:** add `12id.naziharitsolution.com A 123.176.58.72`. Checked 2026-09-14: the apex has no A record, and the wildcard `*.12id…` does not cover it. Cookies stay host-only (Better Auth `crossSubDomainCookies` is off by default), so session cookies never reach `api.`, `mediator.` or `agent.`. Production hostname decided with the production domain |

## Architecture
```
browser ──Better Auth session cookie──▶ console (TanStack Start, :3600)
                                          │ server functions only, via guard wrappers
                                          │ x-console-token / -tenant / -actor
                                          ▼
                                     platform-api (:3500, Docker network 12id-agent)
                                          ├─ /v1/*    same routes, tenant from console headers
                                          ├─ /v1/api-keys   (new, console principal only)
                                          └─ /admin/* (existing; now also console token + operator)
console DB (Better Auth) ── separate database `console` on agent-postgres
```
Tenant isolation lives in two places:
1. The console guard resolves the tenant from the session's organization membership, never from client input, for tenant members.
2. platform-api scopes every query by `request.tenant` (unchanged).

The console token can act as any tenant, so it:
- exists only on the internal network;
- is refused at the edge;
- is audited per call with the actor.

## Workstreams

### C0 — Spike (gates C2) — record in `12id/implement/12-phase-4-findings.md`
Pin exact versions of `@tanstack/react-start`, `@tanstack/react-router`, `better-auth`, the Better Auth CLI (docs now say `npx auth@latest`; pin it, never `@latest` in scripts), `drizzle-orm`/`drizzle-kit` and `vite` (no caret ranges). In a `node:22.20.0-bookworm-slim` container against local Docker Postgres, verify each against the pinned versions, because the docs move:

- **Schema workflow:** `auth generate` → `drizzle-kit generate` → committed SQL migrations applied by `drizzle-kit migrate` / the drizzle migrator on a dedicated `console` database; regenerate when a plugin is added.
- **Sign-up with invitations only.** Better Auth's `disableSignUp` would also block invitees from creating an account. Settle the mechanism, recommended: a `hooks.before` on the email sign-up endpoint that allows it only when a pending invitation exists for that email, plus the operator bootstrap script via server-side `auth.api` calls. Also `requireEmailVerification` (the invite link proves the address).
- **`organization`:**
  - `schema.organization.additionalFields.platformTenantId` (+ `inferOrgAdditionalFields` on the client);
  - `allowUserToCreateOrganization: false`;
  - `organizationHooks.beforeCreateOrganization` refusing an organization without `platformTenantId`;
  - `sendInvitationEmail`;
  - active organization set by a `databaseHooks.session.create` hook;
  - `auth.api.hasPermission` on the server.
- **`twoFactor`:**
  - TOTP enroll/verify, `otpOptions.sendOTP` email OTP, backup codes, `trustDevice`;
  - the sign-in `twoFactorRedirect` / `twoFactorPage` flow;
  - how to restrict operators to TOTP (read `twoFactorMethods` at enrollment + middleware check).
- **`admin`:** `adminRoles: ['operator']` with a custom access-control role, ban, revoke sessions. Impersonation stays **off** unless we decide otherwise.
- **TanStack Start:**
  - global request middleware in `src/start.ts`;
  - `createMiddleware({ type: 'function' })` with `.middleware([authMiddleware])`;
  - `createServerFn().middleware([...]).validator(zod)` (confirm whether the pinned version names it `validator` or `inputValidator`);
  - `vite build` output run with plain `node`.
- **Behind Caddy:**
  - `baseURL`, `trustedOrigins`;
  - `ipAddress.ipAddressHeaders` + `trustedProxies` matching Caddy on host networking (so rate limits see real client IPs, not the proxy);
  - `rateLimit` with database storage;
  - cookies `Secure` / `HttpOnly` / `SameSite=Lax`, host-only;
  - `BETTER_AUTH_SECRETS` rotation.

### C0 outcomes (2026-09-14) — where the spike changed this plan
Evidence in [12-phase-4-findings.md](12-phase-4-findings.md).
- **Production runtime: `srvx`, not Nitro.** Nitro is published only as a beta; a plain `vite build` plus `srvx --prod -s ../client dist/server/server.js` serves the app. Dependencies stay external to the server bundle, so the image ships production `node_modules`.
- **Invitee accounts are created server-side, not by a sign-up hook.** `disableSignUp` blocks every caller; the admin plugin's `auth.api.createUser` accepts a server call without headers. The invitation page's server function validates the invitation, then creates the user. First operator: `npx auth create-admin --role operator`.
- **Operator TOTP-only needs our code:** Better Auth offers email OTP to every 2FA user; an after-hook refuses operator sessions from `/two-factor/verify-otp`, and `operatorMiddleware` requires a verified TOTP secret.
- **CSRF: TanStack Start's `createCsrfMiddleware`** in `src/start.ts` (server functions including GET, and all non-GET requests), with the public origin as matcher. Replaces the hand-written origin check.
- **Every form: `method="post"` and submit disabled until `useHydrated()`**; a pre-hydration click otherwise submits the password as a GET query string.
- **Routes as built:** `/login`, `/verify-2fa`, `/setup-2fa`, `/_authed`, `/_authed/ops`, `/_authed/account` (tenant portal placeholder).
- **Tests:** Vitest for units (the `node --test` rule exists because of Credo, which the console never loads); Playwright `npm run e2e` against local Postgres and a local platform-api; outgoing mail can be appended to `MAIL_OUTBOX_FILE` outside production, so tests read real codes.
- **Pins confirmed:** TanStack Table **v9** (shadcn's data-table targets it); Better Auth CLI is the `auth` package; shadcn preset `nova` on Base UI; `cn` package verified as shadcn's.

### C1 — platform-api: console scope, audit, new routes
Files: `src/http/auth.ts`, `src/http/app.ts`, `src/config.ts`, `src/db/schema.ts` (+ migration), new `src/http/routes/console.ts`, `routes/admin.ts`.

- **Config:** `CONSOLE_TOKEN` (secret, ≥32 chars, optional; the scope is disabled when unset).
- **Principal:**
  - Generalise `TenantContext` to carry `principal: { kind: 'apiKey', apiKeyId } | { kind: 'console', actor, role }`.
  - New hook `requireTenantPrincipal(db, consoleToken)`:
    - A bearer API key → as today (`requireApiKey`).
    - Otherwise `x-console-token` (constant-time via `tokenMatches` from `@12id/credo-base/internal-token.ts`) + `x-console-tenant` (uuid, must exist) + `x-console-actor` → `request.tenant`.
  - Replace the hook on the customer scope in `app.ts`, so catalogue, exchanges, templates, wallets and webhook routes serve both principals. Idempotency keeps working because it keys on `request.tenant`.

  > **Phase 7 update (2026-09-22, review K1):** both principals still reach those routes, but the setup writes are now **console principal only**: catalogue publishing, templates, biometric policies and the webhook endpoint. They use the shared `requireConsolePrincipal` in `http/auth.ts`, the same guard as `/v1/api-keys` below. See [`17-phase-7.md`](17-phase-7.md) K1.
- **Operator access:**
  - `/admin/*` accepts either `x-admin-token` (break-glass over SSH, kept) or console token + `x-console-role: operator` + actor.
  - Update `requireAdminToken` into `requireOperator`.
- **Audit:** table `console_audit` (`id`, `at`, `actor`, `role`, `tenant_id` nullable, `method`, `route` pattern, `status_code`, `request_id`).
  - Written in `onResponse` for every console-principal request that mutates, plus key-creation and secret-rotation responses.
  - `GET /admin/audit?tenantId=&actor=` for operators.
- **New routes:**
  - `POST/GET /v1/api-keys`, `DELETE /v1/api-keys/:id`: **console principal only** (403 for API keys, so a leaked key cannot mint more). Reuse `generateSecret`, `hashSecret`, `lookupPrefix` from `src/auth/tokens.ts`. The plaintext is returned once.
  - `GET /admin/tenants/:id` (detail).
  - `GET /admin/overview`: per tenant, status, counts of connections / credentials / proofs by state, wallets, dead deliveries, last activity.
  - `GET /admin/webhook-deliveries?status=dead` across tenants.
- **Edge:** the `api.` Caddy site answers 404 to any request carrying `x-console-token` or `x-console-*`. The console reaches platform-api at `http://platform-api:3500` on `12id-agent`.
- Regenerate and commit `openapi.json`. Console routes are tagged `console` and hidden from the customer spec (`hide: true`); `npm run openapi` also emits `openapi.console.json` for the console's typed client.
- **Tests** (`node --test --test-concurrency=1`):
  - scope accepts API key / console headers and rejects a missing or wrong token, an unknown tenant, or a missing actor;
  - an API key calling `/v1/api-keys` → 403;
  - an operator-role header is required for `/admin/*` via console;
  - audit rows are written;
  - responses still strip unknown fields;
  - no SQL in 500 bodies (Phase 2 regression).

### C2 — Console app skeleton (`12id/console/`)
The layout follows the TanStack Start docs (project structure, authentication, server functions, middleware) and the Better Auth TanStack Start integration guide, both read 2026-09-14. C0 re-checks them against the pinned versions.

```
package.json / package-lock.json     exact pins; scripts: dev (vite dev), build (vite build), start (node on the build output),
                                     typecheck (tsc --noEmit), test, db:generate, db:migrate, openapi:client
vite.config.ts                       tanstackStart() plugin placed before @vitejs/plugin-react; @tailwindcss/vite
components.json                      shadcn config (created by `npx shadcn@<pinned> init -t start`, npm, Base UI, `@/*` alias)
src/styles/app.css                   Tailwind v4 entry + shadcn theme CSS variables (brand tokens overridable per deployment)
src/components/ui/                   shadcn components added via the CLI (button, card, dialog, field, input, combobox,
                                     table, tabs, badge, dropdown-menu, sidebar, sheet, alert-dialog, tooltip, avatar, breadcrumb,
                                     checkbox, switch, textarea, sonner, skeleton, …); never hand-edited beyond theming
src/components/shell/                app shell (C7): AppShell (SidebarProvider + AppSidebar + AppHeader), WorkspaceSwitcher,
                                     UserMenu, ThemeToggle, AuthLayout, use-shell-model (nav groups + breadcrumb from useMatches)
src/components/form/                 form kit (C7): useAppForm/Form with TextField, PasswordField, TextareaField, NumberField,
                                     CheckboxField, CheckboxGroupField, SwitchField, ComboboxField, SubmitButton, FormError;
                                     FormDialog for short forms; submitMutation glue to TanStack Query
src/components/                      app components: DataTable (TanStack Table + shadcn table: sorting, filters, pagination,
                                     toolbar slot; server-driven since C9, see below), PageHeader (title + actions slot), ConfirmDialog (AlertDialog for every
                                     state-changing action), RowAction (icon + tooltip, optional confirm), IdentifierPair /
                                     CopyableValue, StateBadge, SecretOnceDialog (API key / webhook secret shown once)
src/components/dashboard/            dashboard kit (C8): StatTile + StatGrid (KPI row), AttentionList (icon + label + count +
                                     link), RangeTabs (7/30/90 days in the route search), GettingStarted (portal checklist),
                                     ActivityChart (grouped columns per day) and OutcomeBar (stacked done / in flight /
                                     abandoned) on shadcn `ui/chart.tsx` (recharts), hydration-gated behind a fixed-height skeleton
src/integrations/query.tsx           QueryClient + TanStack Router SSR-Query integration; route loaders use
                                     queryClient.ensureQueryData(queryOptions → server functions)
tsconfig.json                        jsx react-jsx, moduleResolution Bundler, module ESNext, target ES2022,
                                     verbatimModuleSyntax OFF (docs: prevents server code leaking into client bundles)
drizzle.config.ts, drizzle/          committed migrations for the `console` database (auth generate → drizzle-kit generate)
src/router.tsx                       createRouter({ routeTree }); routeTree.gen.ts is generated, committed as the plugin expects
src/start.ts                         createStart(): global requestMiddleware (request id, security headers) and
                                     functionMiddleware (logging); NOT auth: auth is attached per server function
src/routes/__root.tsx                createRootRoute: HeadContent/Scripts/Outlet; beforeLoad loads the session via
                                     getSessionFn so SSR and client share one auth state
src/routes/api/auth/$.ts             server route: GET/POST → auth.handler(request)   (Better Auth handler)
src/routes/api/health.ts             server route for the healthcheck
src/routes/login.tsx, 2fa.tsx, 2fa.setup.tsx, invite.$id.tsx, reset-password.tsx
src/routes/_authed.tsx               pathless layout: beforeLoad → redirect to /login without a session,
                                     to /2fa/setup without 2FA enabled (operators: TOTP)
src/routes/_authed/ops.tsx + ops/…   operator area; beforeLoad requires role `operator`   (stage 4a)
src/routes/_authed/t.$orgSlug.tsx + t.$orgSlug/…   tenant portal; beforeLoad sets the active org, requires membership (4b)
src/lib/permissions.ts               createAccessControl + roles, shared by server and client plugins
                                     (org: owner/admin/member over apiKey, webhook, catalogue, template, member, invitation;
                                     admin plugin: operator)
src/features/<area>/<area>.schemas.ts   zod input schemas shared by forms and server-function validators (client-safe);
                                     src/lib/template-schema.ts holds the builder's (templateDefinitionForm) and the server's
                                     (templateDefinitionInput) template shapes around one set of rules
src/lib/auth-client.ts               createAuthClient({ plugins: [organizationClient({ ac, roles }), inferOrgAdditionalFields,
                                     twoFactorClient({ twoFactorPage: '/2fa' }), adminClient()] })
src/server/auth.server.ts            betterAuth({ baseURL, secret(s), trustedOrigins, database: drizzleAdapter(db, { provider: 'pg' }),
                                     emailAndPassword { requireEmailVerification, sendResetPassword }, rateLimit { storage: 'database' },
                                     advanced.ipAddress, hooks (invite-only sign-up), databaseHooks (active org),
                                     plugins: [organization(...), twoFactor({ issuer: '12id', otpOptions: { sendOTP } }),
                                     admin({ adminRoles: ['operator'] }), tanstackStartCookies() /* must be last */] })
src/server/middleware.ts             authMiddleware (auth.api.getSession({ headers: request.headers }), requires 2FA enabled
                                     and the session's 2FA verified) → operatorMiddleware / tenantMiddleware(permission)
                                     (org membership via platformTenantId + auth.api.hasPermission) → context.principal
src/server/platform.server.ts        openapi-fetch client typed from platform-api's openapi.console.json; platformFor(principal)
                                     sets the x-console-* headers; maps platform errors to typed results
src/server/email.server.ts, db.server.ts, env.server.ts (zod: DATABASE_URL, BETTER_AUTH_SECRET(S), BETTER_AUTH_URL,
                                     PLATFORM_API_URL, CONSOLE_TOKEN, SMTP_URL, MAIL_FROM)
src/features/<area>/<area>.functions.ts   createServerFn().middleware([tenantMiddleware(...)|operatorMiddleware]).validator(schema)
                                     areas: tenants, api-keys, catalogue, templates, exchanges, wallets, webhooks, members, audit,
                                     dashboard (C8: getOperatorDashboard, getTenantDashboard, getTenantDashboardFor)
src/features/<area>/*-dialog.tsx     the area's short forms as FormDialogs (create tenant / organization / API key, invite
                                     operator / member, change role, publish schema, webhook endpoint, connection invitation)
scripts/create-operator.ts           bootstrap first operator through auth.api (one-time set-password link, TOTP enrollment on first login)
Dockerfile                           build stage → node:22.20.0-bookworm-slim runtime, USER node
test/                                middleware + isolation tests
```
Conventions from the docs:
- **`.functions.ts`** holds only `createServerFn` wrappers (safe to import anywhere; the client gets RPC stubs).
- **`.server.ts`** is server-only and is imported only from handlers and middleware.
- **Plain `.ts`** is client-safe (schemas, permissions, types).
- **Route guards (`beforeLoad`) are for navigation UX only.** The data boundary is the middleware on every server function, as both docs stress.

Rules on top:
- **`platformFor` needs a `principal`, and only `middleware.ts` produces one** (a branded type). A test fails if any `createServerFn` in a `.functions.ts` file lacks an auth middleware, or if a `.server.ts` module is imported from a non-server file.
- **Tenant members:** `tenantId` comes from the org's `platformTenantId`, never from input. Operators pass `tenantId` explicitly, and `operatorMiddleware` checks the role.
- **2FA:** Better Auth enables it per user, so `authMiddleware` enforces it globally. Operators must use TOTP, so an operator whose only method is email OTP is sent to setup.
- **Sessions:** operators 12 h, no trusted devices; members 7 days with 24 h refresh, trusted device allowed. "Sign out all sessions" is available.

### C3 — Stage 4a: operator console
Routes: `/login`, `/2fa`, `/ops` (dashboard since C8; the tenants table until then), `/ops/tenants` (C8), `/ops/tenants/$id/*`, `/ops/operators`, `/ops/audit`.
- **Tenants:**
  - List from `/admin/overview`: status, DID, last error, activity.
  - Create: `POST /admin/tenants` → create the organization with `platformTenantId` → optional owner invite.
  - Onboard retry for `failed`.
  - Ordering and retry-safety: the tenant is created first. If organization creation fails, the tenant page shows "no organization" with a create action. An organization is never created without a tenant id.
- **Tenant detail (read views through the console scope):**
  - API keys: create (shown once), revoke, last used.
  - Catalogue: schemas and credential definitions with **both** unqualified and qualified ids, and status.
  - Templates; connections, credentials and proofs (filters by state, `externalId`; proof `verified` + `disclosed`); wallets.
  - Webhook endpoint; deliveries with body and retry.
  - Members and invitations.
- **Cross-tenant:** failed tenants, dead deliveries (`/admin/webhook-deliveries`).

  > **C9 update (2026-09-24):** every one of these lists is paged, searched and filtered on the server, with its state in the URL, newest first. In the tenant sidebar, Wallets comes before Exchanges. Exchanges, Catalogue and Members are tabbed. See §C9.
- **Operators:** invite operator, ban/unban, revoke sessions (admin plugin). Audit log viewer (`/admin/audit`).
- The SSH `x-admin-token` path stays as break-glass; runbook updated.

### C4 — Stage 4b: tenant portal
Routes: `/t/$orgSlug/*` (`/t/$orgSlug` itself is the Overview since C8; a redirect to Catalogue until then). Organization switcher for users in several organizations.

| Role | Can do |
|---|---|
| `owner` | everything + member management + delete invitations |
| `admin` | API keys, webhook, catalogue publish/deprecate, templates |
| `member` | read-only browsers and delivery log |

Screens:
- **Members:** invite by email (link fallback), change role, remove; accept-invitation flow with 2FA enrollment.
- **API keys:** `/v1/api-keys` (shown once).
- **Catalogue:**
  - Publish schema: name, version, attributes. The form requires `expiresAt` and explains 4-init §5.2 encoding rules.
  - Publish credential definition (no revocation, stated in the UI).
  - Deprecate / reactivate.
- **Proof template builder:**
  - Groups with a unique key.
  - Credential refs by schema name (`versions: all|active`) or credential definition id, picked from the catalogue.
  - Disclosed attributes from that schema's attribute list.
  - Integer predicates.
  - Client-side mirror of `validateTemplate` (`services/platform-api/src/templates.ts`): `expiresAt` never selectable, an attribute not both disclosed and predicated, unique keys. Server 400s are shown inline.
  - Preview of the expanded unqualified cred def ids.
- **Webhook:** set the https URL and event filter; the secret is shown once on create/rotate; deliveries log with status filter, body, retry.
- **Browsers:** connections / credentials / proofs / wallets (read-only), plus "create connection invitation" with a QR image rendered client-side, for testing with the sample app.

  > **C9 update (2026-09-24):** the browsers page on the server. On the exchanges, the external-id search is a contains match, with state and creation-date filters. External id is the first column of credential and proof exchanges. See §C9.

### C5 — Staging deploy
- **`infra/staging/compose.console.yml`:**
  - `console-migrate` (init: ensure `console` database + Better Auth migrations);
  - `console` on `127.0.0.1:3600`, network `12id-agent`, `mem_limit 512m`, `stop_grace_period 30s`, healthcheck `/api/health`.
- **Secrets:**
  - `secrets/console.sops.env`: `BETTER_AUTH_SECRET`, `CONSOLE_TOKEN`, optional `SMTP_URL`.
  - `CONSOLE_TOKEN` is added to `platform.sops.env` too (keep in step, as with `MEDIATOR_ADMIN_TOKEN`).
  - Deploy with `EXTRA_SECRETS="agent platform"`.
- **Caddy:**
  - `12id.naziharitsolution.com` (after the owner adds the apex A record): `import hardening`, CSP + `frame-ancestors 'none'`, `per_ip_limit console_per_ip 300`, reverse_proxy 3600.
    > **Phase 7 update (2026-09-22, review M12):** the edge no longer sets the CSP. The console sends a per-request nonce policy (`script-src 'nonce-…' 'strict-dynamic'`, `frame-ancestors 'none'`, …) from `src/start.ts`. The router and next-themes stamp the nonce on their scripts. The staging Playwright specs fail on any violation. See [`17-phase-7.md`](17-phase-7.md) M12.
  - `api.<domain>`: block `x-console-*` headers.
  - Recreate the Caddy container after syncing the Caddyfile (Phase 3 trap 29).
- `infra/scripts/backup-postgres.sh`: add `console`; one restore drill (restored database, a login works).
- **Monitoring:** blackbox probe `https://console.<domain>/api/health`; container restart alert already covers it.
- **Runbook** `infra/runbooks/console.md`: bootstrap operator, rotate `CONSOLE_TOKEN`, lost 2FA recovery by an operator, break-glass admin token.

### C6 — Smoke and security checks
- **`infra/smoke/console.ts`** (Playwright, workstation, against staging):
  1. Operator logs in with password + TOTP (secret seeded by `create-operator.ts`, code via otplib). An attempt to use email OTP as an operator is refused.
  2. Creates a tenant and waits for `ready`; invites an owner (link fallback).
  3. The owner accepts and enrolls 2FA **with email OTP**; the code is read from a test SMTP catcher (e.g. a Mailpit container reachable only from the workstation tunnel). The owner then creates an API key, publishes schema + cred def, builds a template and sets the webhook. A second member enrolls with TOTP.
  4. Then run the existing **`smoke:platform-credo`** with that API key → must PASS unchanged.
- **Isolation suite:** two organizations. A member of A calls every tenant server function with B's organization slug, B's record ids, and forged `tenantId` inputs → all denied. A `member` role → mutations denied. An account without 2FA → only enrollment reachable.
- **From outside:**
  - `api.` with `x-console-token` → 404;
  - `:3500`/`:3600` closed;
  - `/admin/*` still 404;
  - console routes unauthenticated → redirect to login;
  - Better Auth rate limit returns 429 on a login burst;
  - `console_audit` rows present for every mutation in the smoke.
- No holder change, so no Android run is required for the Phase 4 gate.

### C7 — Console UI revamp (2026-09-17)
The first build of 4a/4b grew page by page: three hand-rolled nav bars, no organization switcher, dead dark-mode CSS, forms with native HTML validation bubbles sharing their column with the table they feed, fourteen state-changing actions without confirmation, native `<select>`s. C7 replaces that with one set of patterns; no server-function contract changes, no platform-api changes.

- **Shell** (`src/components/shell/`, mounted once in `_authed.tsx`): shadcn sidebar (collapsible to icons, sheet on phones) whose top item is the **workspace switcher** (operator console + the viewer's organizations from `myOrganizationsQuery`, loaded in the `_authed` loader together with the sidebar cookie); nav groups and breadcrumb derived from the matched routes (`use-shell-model.ts`: operator sections, a contextual "Tenant · name" group inside a tenant, organization sections in the portal); header with sidebar trigger, breadcrumb, **theme toggle** (`next-themes`, class strategy, `suppressHydrationWarning` on `<html>`) and **profile menu** (avatar, organizations, operator console, sign out). Auth pages share `AuthLayout`.
- **Form kit** (`src/components/form/`): `useAppForm` (TanStack Form `createFormHook`) + `Form` (`noValidate method="post"`) + field components on shadcn `Field`/`FieldError`. `revalidateLogic()` with the zod schema as `onDynamic` validator: quiet until the first submit, then live per field. Inputs are read-only and controls disabled until `useHydrated()` (a controlled input would drop text typed before hydration; the submit button waits for the same reason). Schemas live in `features/<area>/<area>.schemas.ts` and are the server functions' validators too; where the form holds a different shape (attributes as text, "all events" switch, blank alias, password confirmation) a `…Form` schema sits next to the `…Input` one with a converter.
- **Placement rule:** short forms open in a `FormDialog` from the page header's actions slot (`PageHeader`); the proof template builder has routes (`/t/$orgSlug/templates/new`, `/t/$orgSlug/templates/$templateId/edit`) with an unsaved-changes guard (`useBlocker`). `/ops/tenants/new` is gone (dialog).
- **Confirmation:** `ConfirmDialog` (AlertDialog: title naming the object, consequence, pending state, inline error) in front of ban/unban/sign-out-everywhere, remove member, cancel invitation, change role (dialog), delete template, publish credential definition, deprecate/reactivate, rotate/remove webhook, revoke API key, retry delivery, retry onboarding. `RowAction` = icon button + tooltip whose accessible name is the label, with an optional `confirm`.
- **Combobox** (`ComboboxField`/`ComboboxControl`, Base UI) for member roles, schema names, versions, predicate attributes and comparisons; `CheckboxGroupField` for webhook events and disclosed attributes; `SwitchField` "deliver all events" (an empty selection is now an error instead of silently meaning all).
- **Template builder:** `templateDefinitionForm` (every array present) with the cross-field rules as a `superRefine` that places each issue on `groups[i].key` / `.attributes` / `.predicates[j].name`; array fields for groups, credentials and predicates. The server validates `templateDefinitionInput` (same rules, platform-api shape).
- **Tests:** unit test of the rule paths; e2e specs updated for dialogs (`getByRole('dialog')` scoping), confirmations (`getByRole('alertdialog')`), the profile menu and the combobox (`fill` + `option`).
- **Password reset from the login page** ("Forgot your password?" → the same set-password mail Better Auth sends for a first password). The answer never says whether the address has an account.
- **Lost sessions lead to sign-in, not an error page:** the operator 12 h cap lives in `lib/permissions.ts` and is applied by `getViewer`, so the route guards see it; a middleware without a usable session throws a router redirect to `/login`, which `router.tsx` also follows for queries and mutations. Dialogs cap their height and scroll.

### C8 — Dashboards: operator dashboard and tenant Overview (2026-09-17)
After C7 the console has one shell and one form kit, but no page that answers "how is this doing?". `/ops` is the raw tenants table (`/admin/overview` per tenant; no totals, no trend, no "needs attention", and service health only on the hidden `/readyz`), and `/t/$orgSlug` is a redirect to Catalogue: a customer signing in sees a table and has to guess where their exchanges, wallets and webhook failures are. There is no aggregate endpoint anywhere and nothing buckets by time. C8 adds two dashboards on two new console-scope routes, with the tenant dashboard reused on the operator's tenant detail. Decisions taken with the owner: `/ops` becomes the dashboard (tenants → `/ops/tenants`); shadcn `chart` + recharts; the stats routes are console-scope only; counters + a 30-day series + attention lists in the first pass.

**platform-api** — new `src/http/routes/stats.ts`, registered next to `exchangeRoutes` and `adminRoutes`:
- **`GET /v1/stats?days=30`** on the customer scope, **console principal only** (403 for an API key, like `/v1/api-keys`), tagged `CONSOLE_ONLY_TAG` so it is in `openapi.console.json` and not the customer `openapi.json`. `days` is `7…90`, default 30. Body: `tenant` (id, name, status, did, lastError); `totals` (connections / credentials / proofs by state + totals, proofs verified / failed, wallets and API keys active / revoked); `webhook` (configured, url, deliveries by status, last delivered, last failure); `attention` (stuck credentials and proofs, dead deliveries, credentials expiring within 30 days, credentials already expired, wallets never connected); `series` — exactly `days` entries of `{ day, connections, credentials, proofs }` from a `generate_series` day spine left-joined to `created_at::date` counts, so an empty day is `0`, not missing. **A day counts exchanges started that day**; start and outcome dates are never mixed.
  - *stuck* = not in `done` / `abandoned` / `declined` and `updated_at` older than 24 h (trap 25's symptom, made visible).
  - *expiring* = `state = 'done'` and `attributes->>'expiresAt' ~ '^[0-9]+$'` and `to_timestamp(...)` within `[now(), now() + 30 d]`; *expired* the same with `< now()`. The regex guard keeps a non-numeric `expiresAt` (§5.2: a free-form string attribute) from failing the whole dashboard. This is the number that makes the no-revocation model (4-init §4.7, §12.3) operable.
  - *wallets never connected* = `mediator_connection_id is null`, not revoked, older than 24 h (review M10's orphan case).
    > **Phase 7 update (2026-09-22, review M10):** that column is only a cache of the first mediator webhook, and it is reset on every new invitation. The count now uses `wallets.connected_at`, which the wake path and the hourly sweep set from the mediator's own connections. On staging the first sweep found 4 wallets the old definition counted as never connected, and all 4 were connected. See [`17-phase-7.md`](17-phase-7.md) M10.
  - The `count(*) … group by state` SQL already in `/admin/overview` is lifted into a helper that both routes use.
  - **No agent-service call.** Catalogue counts live in agent-service and a credential-definition call can exceed the client timeout (trap 44 / review M5); the console fetches `/v1/schemas` + `/v1/credential-definitions` separately for its catalogue card.
- **`GET /admin/stats?days=30`** under the existing `requireOperator` hook: `platform` (tenants by status, connections, credentials, proofs, wallets, API keys), `outcomes` (by state per kind), `attention` (failed tenants with `lastError`, dead deliveries, stuck exchanges, wallets never connected, tenants without a webhook endpoint), `series`, `topTenants` (top 5 by exchanges in the window) and `health` — the existing `readiness()` report (`database`, `agent`, `mediatorDatabase`, `draining`) passed in as a dep, since `/readyz` is hidden from the typed client.
- **Migration `0003_stats_indexes`:** `(tenant_id, created_at desc)` and `(tenant_id, state)` on `connections`, `credentials` and `proofs`. This is review finding **L3** (`17-phase-7.md` §7), and it also serves the existing list filters.
- **Tests** (`node --test --test-concurrency=1`): `/v1/stats` with an API key → 403, with console headers → 200; counters match seeded rows; `series.length === days` with zero days present; `days=5` / `days=200` → 400; `expiresAt: "not-a-number"` and a missing `expiresAt` do not break the expiring counts; `/admin/stats` with an organization role → 403; response stripping still holds; no SQL in 500 bodies; stats reads write no `console_audit` row. Regenerate both OpenAPI documents: customer spec still 25 paths, console spec 35 → 37; then `npm run openapi:client` in the console.

**console** — routes: `/ops` → **Dashboard**; `/ops/tenants` → the tenants table (file moved verbatim); `/t/$orgSlug` → **Overview** (the redirect goes); `/ops/tenants/$tenantId` keeps its Tenant and Console-organization cards with the shared tenant dashboard above them. Navigation is declared in `use-shell-model.ts` only: `OPS_ITEMS` gains Dashboard (`/ops`, exact) and Tenants moves to `/ops/tenants`; `portalItems` gains Overview (`/t/$orgSlug`, exact); the tenant-detail breadcrumb's Tenants link becomes `/ops/tenants`. The workspace switcher already targets `/ops` and `/t/$orgSlug`, which now land on real pages. *Optional, owner's call:* send a viewer with exactly one organization from `/` to `/t/<slug>` instead of `/account`.
- `src/features/dashboard/`: `dashboard.functions.ts` (`getOperatorDashboard` — operator, `/admin/stats`; `getTenantDashboard` — `tenantMiddleware()`, membership only, so `member` sees it; `getTenantDashboardFor` — operator + `tenantId`, the same `/v1/stats` through `platformFor(principal, { tenantId })`, which is what lets the tenant dashboard render on the operator side), `dashboard.queries.ts` (portal keys through `portalKey(slug, …)`; `staleTime` 60 s), `dashboard.schemas.ts` (`days: 7 | 30 | 90`, default 30, used as the server-function validator **and** as each route's `validateSearch`, so the range is in the URL and identical in the server and client render). The data-boundary scan (`server-functions-guarded.test.ts`) covers the new functions with no test change.
- `src/components/dashboard/`: `StatTile` + `StatGrid` (a KPI row of tiles, not a one-bar chart; proportional figures, `tabular-nums` only in table columns), `AttentionList` (status icon + label + count + a link to the page that fixes it; "Nothing needs attention" when empty; status by icon + label, never colour alone), `RangeTabs` (7/30/90 on the existing `tabs`), `GettingStarted` (portal only: publish a schema → credential definition → API key → webhook → first connection, hidden once complete).
- **Charts:** `npx shadcn@4.21.0 add chart` → `src/components/ui/chart.tsx` + recharts, re-pinned exactly like every other CLI addition. Two forms, chosen by the data's job: `ActivityChart` — trend over time with three distinct series → grouped columns per day (connections, credential exchanges, proof exchanges), legend always present, values in the tooltip, no number on every bar; `OutcomeBar` — part-to-whole → one horizontal stacked bar per kind, segmented done / in flight / abandoned, coloured with the **status** palette and direct labels (states, not series). No dual axis, no third chart; more detail belongs in the tables one click away. **SSR:** recharts' `ResponsiveContainer` measures on mount and renders nothing in the server pass, so every chart sits in a fixed-height box (`h-[220px]`) showing a `Skeleton` until `useHydrated()` — the gate the forms already use (fourth hydration case after traps 32, 36 and C7's controlled inputs; no mismatch was observed with the gate in place).
- **Palette:** the `nova` preset's `--chart-1…5` are a grayscale ramp (`oklch(… 0 0)`), i.e. sequential, and cannot carry three series. `app.css` defines `--chart-1/2/3` = `#2a78d6` / `#eb6834` / `#1baf7a` (dark `#3987e5` / `#d95926` / `#199e70`) for connections / credentials / proofs, and `--status-good/-warning/-critical` = `#0ca30c` / `#fab219` / `#d03b3b` (both modes) for done / in flight / abandoned. Validated with the data-viz palette validator against the console's real card surfaces (`--card` → `#ffffff` light, `#171717` dark): light — lightness, chroma, CVD (adjacent ΔE 9.1) and normal-vision (ΔE 22.9) PASS, contrast WARN on aqua (2.82) and yellow (2.17), which the legend, tooltip values and the tables below relieve; dark — all five PASS. The grayscale `--chart-4/5` stay for a future single-hue magnitude ramp.
- **Pages.** `/ops`: header + range tabs; health strip (three chips from `health.checks` + draining); KPI row (tenants ready of total, connections, credential exchanges, proof exchanges, active wallets, active API keys); `ActivityChart`; `AttentionList` (failed tenants, dead deliveries, stuck credentials, stuck proofs, wallets never connected, tenants without a webhook); top 5 tenants (a table — a hue per tenant would break the series ladder); last 10 audit rows from the existing `/admin/audit` query. `/t/$orgSlug`: header + range tabs; `GettingStarted` while incomplete; KPI row (connections, credentials issued, proofs verified, active wallets, each with its in-flight count beneath); `ActivityChart` + `OutcomeBar` side by side, stacked below `lg`; `AttentionList` (dead deliveries, stuck exchanges, expiring, expired, wallets never connected); webhook card (url or "not configured", counts, last delivery, link); catalogue card with schema / credential-definition counts loaded with `useQuery`, **not** the route loader, so an unreachable agent-service fails only that card. `/ops/tenants/$tenantId`: the same KPI row, chart and attention list from `tenantDashboardQuery(tenantId)` above the existing cards — one set of components, two callers, as `features/tenant-data/panels.tsx` already does.
- **Tests.** `auth.spec.ts` asserts the dashboard at `/ops` and the table at `/ops/tenants`; `staging.spec.ts` and `staging-portal.spec.ts` `goto('/ops/tenants')` before using `tenants-table`; `ops.spec.ts` covers the range tabs changing the search and the chart, and an attention row linking through; `portal.spec.ts` covers landing on Overview with the sidebar item active and the getting-started checklist on a fresh tenant; Vitest covers the range schema and the getting-started derivation.

### C9 — Console lists: server-side paging, search and filters (2026-09-24; on staging, `e2e:staging` 3/3, `smoke:platform-credo` PASSED)
After C8 every console table still loads one array (`limit=200`, or unbounded for API keys, templates, catalogue and members) and sorts, searches and pages it in the browser (`components/data-table/data-table.tsx`, local state, not in the URL). A tenant with more than 200 exchanges cannot see the rest (review finding **L3**, cursor half). The exchange lists cannot be searched by external id or filtered by state or date. C9 makes every list server-paged, with its search and filters in the URL and one fixed order. Decisions taken with the owner:
- **Paging:** page numbers with a total (offset paging). `page ≥ 1`, `pageSize` ∈ {25, 50, 100}, default 25.
- **Envelope:** `{ items, total, page, pageSize }` on **every** list route, customer `/v1` routes included. `limit` is gone. This breaks the old shape, accepted pre-production: outside the console only one smoke line reads a list, and the SDK reads none.
- **Order:** always `created_at desc`, with the primary key as tie-break so pages are stable. The UI has no sort controls.
- **External-id search:** case-insensitive contains (`ILIKE '%term%'`, `%` `_` `\` escaped) on `pg_trgm` GIN indexes.
- **UI:** in the sidebar (tenant detail and portal), **Wallets moves above Exchanges**. On the credential-exchange and proof-exchange tables, **External id becomes the first column**.

**platform-api** — new `src/http/list.ts`: `pageQuery`, `createdRange` (`from` / `to`, ISO date-time, `created_at >= from and < to`), `q` (1–100 chars), `pageOf(item)` (the envelope schema), `containsI(col, term)`, and `listPage()` (rows with `limit`/`offset` and `count(*)` under the same `where`, in parallel).

| Route | Filters | `q` matches |
|---|---|---|
| `GET /v1/connections` | `state` (multi), `from`/`to`, `externalId`, `invitationId` | external id, holder label |
| `GET /v1/credentials`, `GET /v1/proofs` | `state` (multi), `from`/`to`, `externalId`, `connectionId` | external id |
| `GET /v1/wallets` | `status` (active / revoked), `from`/`to` | external id |
| `GET /v1/webhook/deliveries` | `status`, `eventType`, `from`/`to` (order moves from `id desc` to `created_at desc, id desc`) | — |
| `GET /v1/api-keys` | `status` | label, prefix |
| `GET /v1/proof-templates` | — | name |
| `GET /v1/schemas`, `GET /v1/credential-definitions` | `status` | name (and tag) |
| `GET /admin/overview` | `status` | tenant name |
| `GET /admin/webhook-deliveries` | `status`, `tenantId`, `eventType`, `from`/`to` | — |
| `GET /admin/audit` | `tenantId`, `actor` (multi; the console resolves emails to ids), `from`/`to` | route |

- `state` values are checked against per-kind lists in `src/exchange-states.ts` (Credo v1 states plus the biometric held states), mirrored in the console.
- `/admin/overview` pages the tenants first and runs the three per-tenant aggregates for that page's ids only (they scanned every tenant before).
- `openapi.json` and `openapi.console.json` are regenerated (path counts unchanged); `docs/api.md` documents the envelope; `infra/smoke/platform-credo.ts` reads `.items`.

**agent-service** — the catalogue route (`GET /tenants/:id/catalogue`) takes optional `kind`, `status`, `q`, `page`, `pageSize`. With `page` it returns the envelope ordered `created_at desc`; without it, the full array as before, because credential-definition resolution and proof requests need the whole list. Index `ledger_objects (tenant_id, kind, created_at desc)`.

**Indexes** — platform-api migration `0007_list_indexes`:
- `create extension if not exists pg_trgm` (a trusted extension: the database owner role from H3 may create it; checked against `infra/scripts/pg-roles.sh` roles before staging);
- trigram GIN on `connections.external_id`, `connections.their_label`, `credentials.external_id`, `proofs.external_id`, `wallets.external_id`;
- `(tenant_id, state)` → `(tenant_id, state, created_at desc)` on the three mirror tables;
- `(tenant_id, created_at desc)` on `wallets` (replaces `(tenant_id)`), `api_keys` (none before) and `proof_templates` (replaces `(tenant_id)`);
- `webhook_deliveries (tenant_id, created_at desc, id desc)` (replaces `(tenant_id, created_at)`) and a partial `(created_at desc) where status = 'dead'` for the cross-tenant dead list;
- `console_audit (actor, at desc)`.
- `tenants` and the Better Auth tables are small and stay as they are.
- **Added during the build — migration `0008_list_order_indexes`:** every list index ends with the primary key, e.g. `(tenant_id, created_at desc, record_id desc)` and `(tenant_id, state, created_at desc, record_id desc)`, so the fixed order is read from the index with no sort. The `EXPLAIN` numbers are in the findings.

**console**:
- `DataTable` becomes server-driven: `page`, `pageSize`, `total`, page and size callbacks, an optional debounced search box and a filter toolbar. The client sort, filter and pagination models and the header sort buttons are removed. The pager reads "26–50 of 312".
- `lib/list-search.ts`: a base search schema (`page`, `pageSize`, `q`, `from`, `to`) extended per list and parsed like `parseDashboardSearch` (invalid values dropped, defaults kept out of the URL). Every list route has `validateSearch` + `loaderDeps`, and its query key includes the search, with `placeholderData: keepPreviousData`.
- **Toolbar** (shadcn's data-table toolbar pattern):
  - one search box per list, then dashed "faceted" filter buttons that show their selection as badges, then a Reset button while anything is set;
  - pieces: `SearchInput`, `SelectFilter` (one status), `MultiFilter` (states), `DateRangeFilter` (shadcn `calendar` + `popover`, a two-month range with 7/30/90-day presets, inclusive UTC days), `PageSizeMenu`;
  - pager, menus and the date picker stay disabled until hydration.
  - *Owner review, 2026-09-24:* this replaced the first build's native date inputs, the two search boxes on the audit log and the status tabs on deliveries. The audit log now has one box: platform-api's `q` matches the route or the actor id, plus `qActor`, the account ids the console resolves from names and emails.
- The **Exchanges** page becomes three tabs (Connections, Credential exchanges, Proof exchanges; `?tab=`), each with its own search, filters and pager. Only the open tab's query runs. **Catalogue** (schemas / credential definitions) and **Members** (members / pending invitations) follow the same pattern.
- Members, invitations and operators are paged in the console database or through Better Auth `listUsers` (`limit`/`offset`/`total`).

**Tests:**
- platform-api: the envelope and total; stable pages at equal `created_at`; `pageSize` out of range → 400; contains search, case-insensitive, with `%` and `_` literal; state and date filters; tenant isolation of search; `/admin/overview` per page; the `0007` indexes and `pg_trgm`.
- agent-service: the paged catalogue, and the unpaged call still returns the full array.
- console: Vitest for the search parser and the state lists; Playwright `lists.spec.ts` (paging, external-id search, state filter, date range, nav order, first column) and the existing specs updated for tabs.

## Order
C0 → C1 (can start in parallel with C0) → C2 → C3 → C5 (deploy 4a) → C6 for 4a (operator smoke + outside checks) → C4 → C5 redeploy → C6 full (portal smoke, isolation suite, `smoke:platform-credo` with a console-created key) → C7 (UI revamp) → C5 redeploy → `e2e:staging` → **C8** (platform-api stats + migration + OpenAPI → `openapi:client` → shadcn `chart` + palette → dashboard kit → `/ops` and the route move → portal Overview → tenant-detail reuse → e2e updates) → C5 redeploy (both images) → `e2e:staging` → **C9** (migration `0007` + `list.ts` + routes → agent-service catalogue paging → OpenAPI → `openapi:client` → `DataTable` + list search → pages, exchanges first → nav + columns → tests) → C5 redeploy (platform-api, agent-service, console) → `e2e:staging`.

## Verification (gate)
- `tsc --noEmit` + tests green in `platform-api` and `console`, including the isolation suite and the import-scan rule.
- Spike C0 recorded with versions and the enforcement mechanism for 2FA.
- Staging:
  - `compose ps` healthy;
  - `smoke:console` PASSED;
  - `smoke:platform-credo` PASSED with a console-created key;
  - outside exposure checks as in C6;
  - restore drill of `console`;
  - `docker stop` of the console drains cleanly.
- C8 (dashboards):
  - platform-api `tsc --noEmit` + tests green with the stats cases; migration `0003` applied; customer `openapi.json` still 25 paths, `openapi.console.json` 37;
  - console `tsc`, Vitest, `vite build` + `check:client` (recharts adds nothing server-side to the client bundle; note the size delta), Playwright `e2e` 4/4;
  - palette validator output recorded for both modes; screenshots at 1280 and 390 px in light and dark; `document.documentElement.scrollWidth === window.innerWidth` at both widths;
  - staging: both images rebuilt, `compose ps` healthy, `e2e:staging` 3/3, `/ops` showing real numbers, `api.` with `X-Console-Token` still 404, no `console_audit` rows from dashboard reads.
- C9 (lists):
  - `tsc --noEmit` + tests green in platform-api, agent-service and console (Vitest, `vite build`, `check:client`); Playwright `e2e` including `lists.spec.ts`;
  - `EXPLAIN (ANALYZE)` before and after on 50 k synthetic rows per mirror table: external-id contains, state + first page, date range, deep page; no sequential scan of a mirror table;
  - staging: `0007` applied, `pg_trgm` in `platform_api`; `smoke:platform-credo` PASSED; `smoke:biometric-credo` 18/18; `e2e:staging` green; a tenant with more than 25 exchanges pages through, finds a record by a middle fragment of its external id, and filters by state and date.

## Document updates
- `12id/implement/11-phase-4.md` (this plan), `12id/implement/12-phase-4-findings.md`.
- **4-init:**
  - §10 Phase 4 checklist ticked/amended (two roles, stages 4a/4b);
  - §2.6 responsibilities (console);
  - §3 matrix rows: browser → console, console → platform-api console scope;
  - §6: console token is a high-value secret;
  - §7 console package pins;
  - new **§12.14** console auth (Better Auth, 2FA required, no public sign-up, console scope);
  - new **§12.15** SaaS + self-host product decision (console self-host-ready now, stack packaging later);
  - traps found during the build.
- **C8:** §10 Phase 4 checklist line for the dashboards; §2.6 platform-API responsibilities (aggregate stats for the console); trap 45 (secrets files overwritten by a tree sync, found during the staging deploy); `17-phase-7.md` L3 index half marked as delivered by `0003_stats_indexes`.
- **C9:** §10 Phase 4 checklist line for the lists; `17-phase-7.md` L3 closed by C9 (page numbers instead of a cursor, owner decision); `services/platform-api/docs/api.md` list envelope; evidence in `12-phase-4-findings.md` "C9".

## Out of scope
Self-host packaging of the whole stack; OIDC/SSO (Better Auth plugin later); self-signup of tenants; billing; per-API-key rate limits; Swift pass; production ledger (§12.1); Phase 1–3 leftovers (M6 failover, alert email, `indy-node-monitor`, upstream mediator bug report). For C8: publishing `/v1/stats` to customers in `openapi.json` (a later, non-breaking step); usage metering; live-updating dashboards (navigation refetch with a 60 s `staleTime` is enough); Prometheus/Grafana changes; per-tenant quotas (review M3); the rest of the Phase 6 fix set. For C9: cursor paging; sort controls; search over attribute or disclosed values (personal data, review H1); saved filters; CSV export; paging the per-record biometric log.
