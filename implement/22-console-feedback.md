# Console feedback, set 1 — verification dashboards, customer activity, Excel/CSV export, audit, operator accounts

**Status (2026-10-12):** planned and approved by the owner on 2026-10-11 (export as both Excel and CSV, owner question the same day). Set 1 is built and passes locally; nothing is deployed. Results are in
[`23-console-feedback-findings.md`](23-console-feedback-findings.md).

## Context
A self-hosting customer reviewed the console against a 17-item admin checklist. All 17 items are console
features; none touches the API, the SDK, the ledger or the biometric flow. Result of the gap analysis:
1 item fully there (liveness policy), 4 mostly, 7 partly, 5 missing.

## The checklist against the console (2026-10-11, before this work)
The reviewer's terms, as read here: "authentication" is our proof requests, "onboarding" is wallets,
connections and credential issuance, "liveness / identity verification" is the biometric gate.

| # | Item | Status | What exists | What is missing | Where it goes |
|---|---|---|---|---|---|
| 1 | Dashboard | Mostly | Operator dashboard and tenant Overview: health checks, counters, 7/30/90-day activity chart, attention list, top tenants, latest audit entries | Fraud alerts and liveness numbers | C10; set 2 |
| 2 | RBAC | Partly | Fixed roles checked on the server on every request: operator, and owner / admin / member per tenant | Only one operator role; no custom roles or permission editor | C14; builder not now |
| 3 | Admin user management | Mostly | Operators: invite, ban / unban, sign out everywhere, forced 2FA. Members: invite, change role, remove | Delete or edit an operator; last sign-in | C14 |
| 4 | Maker–checker | Missing | Every change applies at once (confirm dialog plus audit entry) | Everything | set 2 |
| 5 | Privileged access | Partly | Operators TOTP-only, 12 h sessions, no impersonation, personal data masked until an audited reason is given, break-glass token only over SSH | Access reviews, sign-in alerts, IP restriction; no session recording or time-boxed access | C13/C14 in part; not now |
| 6 | Authentication dashboard | Partly | Proof counts by state, verified / failed totals, daily series of started exchanges | Success / failure rate over time; a page of its own | C10 |
| 7 | Liveness dashboard | Partly | Per exchange: status, scores, attempts, reason and the full log; a failure-rate alert to ops | Any aggregate: pass / fail rates, rejection reasons, trends | C10 |
| 8 | Customer activity | Partly | Wallet, connection, credential and proof lists with external-id search, state and date filters | One page per end user that combines them | C11 |
| 9 | Fraud management | Missing | Nothing | Everything | set 2 (security events) |
| 10 | Alert management | Partly | 26 Prometheus rules → Alertmanager → mail to ops; attention lists in the console | In-console view, acknowledge, escalation; nothing reaches tenants | set 2 |
| 11 | Notification center | Missing | Only mail for invitations and password resets | Everything | set 2 |
| 12 | Audit logs | Partly | Every console change that reaches platform-api, with actor, role, tenant, change details and reason; audited sensitive reads; biometric log; erasure log; searchable viewer | Sign-ins and account actions (they never reach platform-api); tamper protection; export. API-key calls are not in the audit (their trace is the exchange record) | C13, C12 |
| 13 | Liveness policy | Have | Tenant default, per credential definition, per proof template (off / required / conditional rule), minimum liveness and match scores, attempts, time limit, provider setup with a connection test | — | — |
| 14 | Location analytics | Missing | We store no IP or location, by design | Everything | not now |
| 15 | Reports | Missing | No export of any kind (CSV was deferred in C9) | Everything | C12; PDF not now |
| 16 | System configuration | Partly | Tenant: biometric provider, policies, webhook, API keys, retention, members. Operator: per-tenant rate limit | Platform settings live in env files, with no UI | set 2 (read-only panel) |
| 17 | System health | Mostly | Prometheus, Alertmanager, Grafana, 22 targets, probes, ledger write probe, edge error rate | The console shows only a 4-check health strip; no API latency view | set 2 |

Item 12 was first rated "mostly"; reading the code showed that account actions are unaudited (below), so it is "partly".

Two points to raise with the reviewer:
- **"3D liveness":** our provider is AWS Rekognition Face Liveness. FaceTec is designed for (the provider port) but not built.
- **Tenant suspension:** tenants cannot be suspended (the statuses are provisioning, ready, failed). Not in the checklist, but likely to come up with item 3.

The owner chose to build **set 1** now: the items whose data already exists. Set 2 and the "not now" list
are recorded below and go into the implement doc, so they are not lost.

Because the customer self-hosts, its staff are the operators. So every new view must also work on the
operator side, and nothing may depend on our SaaS. Everything ships in the normal release bundle.

Two things found while reading the code change the size of the audit work:
- **Account actions are not audited today.** `console_audit` is written only by platform-api
  (`services/platform-api/src/http/audit.ts`). Sign-ins, operator invite / ban / unban, member invite /
  role change / removal all run through Better Auth in the console and leave no audit row.
- **The audit names its actor only by Better Auth user id.** The viewer resolves ids to emails from the
  console database, so deleting an account would make its past audit rows unreadable.

Paths below are relative to `12id/`. Workstreams continue the console numbering (C0–C9 exist).

## Order
C13 (audit events, needed by C12 and C14) → C14 → C10 → C11 → C12 → docs → staging as `v0.4.0-rc.1`.
Rough size: about 3 weeks (C10 4–5 d, C11 2–3 d, C12 2–3 d, C13 3 d, C14 3–4 d). These are estimates.

---

## C13 — Audit: account events, actor label, append-only (feedback 12)

**platform-api**
- Migration `drizzle/0012_audit_events.sql` (+ `src/db/schema.ts`):
  - `console_audit.actor_label text` (the actor's email at the time of the action);
  - a trigger function that refuses `UPDATE` and `DELETE` on `console_audit` and `erasures`, plus a
    statement trigger that refuses `TRUNCATE`. `test/helpers.ts` disables the trigger for its own cleanup.
  - This guards against application bugs and injection through the app. It does not stop a database
    owner; the pulled off-site backups are the independent copy. A hash chain stays in "later".
- `src/http/auth.ts`: read `x-console-actor-label` (URI-encoded, ≤ 320 chars) in `consoleIdentity`;
  `audit.ts` stores it. `GET /admin/audit` returns it, and `q` matches it.
- New `POST /admin/audit/events` in `src/http/routes/admin.ts` (console token; a role is optional, since a
  failed sign-in has no user). Body: `type`, `outcome`, optional `actor`, `actorLabel`, `role`,
  `tenantId`, and `detail` (≤ 2 KB, passed through the existing `auditChanges` redaction in
  `src/http/audit-changes.ts`). Stored as a `console_audit` row with `method = 'EVENT'`, `route = type`.
- Event types: `auth.sign_in`, `auth.sign_in_failed`, `auth.second_factor_failed`, `auth.sign_out`,
  `auth.password_reset_requested`, `auth.password_reset`, `auth.two_factor_enrolled`,
  `account.operator_*` (invited, banned, unbanned, sessions_revoked, updated, role_changed, deleted),
  `account.member_*` (invited, invitation_cancelled, invitation_accepted, role_changed, removed),
  `export.run`.
- `GET /admin/audit` gains a `kind` filter (`change | sign-in | account | export`), a route-prefix match.

**console**
- New `src/server/audit.server.ts`: `recordEvent()` posts to platform-api. Fail-open and logged, like the
  existing audit hook (a failed audit write never blocks the action).
- `src/server/auth.server.ts` `hooks.after`: map Better Auth paths (`/sign-in/email`,
  `/two-factor/verify-totp|verify-otp|verify-backup-code`, `/sign-out`, `/request-password-reset`,
  `/reset-password`, `/two-factor/enable`) to events, with IP and user agent in `detail`.
  **First step: read the installed better-auth 1.7.4 source** for what the after-hook sees on a failure
  and on the 2FA redirect, as C0 did. Do not trust the docs.
- Call `recordEvent()` after success in `features/operators/operators.functions.ts`,
  `features/portal/members.functions.ts`, `features/tenants/tenant-owner.functions.ts`,
  `features/invitations/invitation.functions.ts`.
- `src/server/middleware.ts`: `Principal` gains `email`; `src/server/platform.server.ts` `platformFor`
  sends `x-console-actor-label`.
- `src/routes/_authed/ops/audit.tsx` + `features/ops/*`: show the stored label (fall back to the lookup
  for old rows), a Kind facet, readable text for event rows.

**Tests:** platform-api — the events route (token required, redaction, size cap), the label stored and
searched, the trigger refusing update / delete / truncate. Console — Vitest for the path-to-event map;
Playwright: a failed and a successful sign-in and an operator invite each appear in the audit log.

## C14 — Operator accounts: auditor role, delete, edit, last sign-in (feedback 2, 3)

- `console/src/lib/permissions.ts`: `AUDITOR_ROLE = 'auditor'`, a platform role with no user or session
  permissions. `sessionExpired` (12 h) and the TOTP-only after-hook cover it like an operator.
- `console/src/server/middleware.ts`: split into `operatorReadMiddleware` (operator or auditor) and
  `operatorMiddleware` (operator only). Every `/ops` `GET` server function moves to the read one.
  Extend `console/test/server-functions-guarded.test.ts`: a `POST` function may not use the read one.
- platform-api `src/http/auth.ts`: add `auditor` to `CONSOLE_ROLES`. In `requireOperator` and
  `requireTenantPrincipal`, an auditor passes for `GET` / `HEAD` only (403 otherwise).
  `src/http/personal-data.ts`: an auditor's reveal reason is refused; personal data stays masked.
- Operators page (`routes/_authed/ops/operators.tsx`, `features/operators/*`):
  - columns: role, 2FA enrolled, last sign-in, status;
  - actions: edit name, change role (`auth.api.setRole`), delete (`auth.api.removeUser`), next to the
    existing ban / unban / sign out everywhere; the invite dialog gets a role choice;
  - server guards: never yourself, and never the last active operator (delete, ban or demote).
- Delete is a real delete. Past audit rows stay readable through `actor_label` (C13).
- Last sign-in: `user.lastSignInAt` as a Better Auth additional field (`input: false`), set by the
  sign-in hook from C13. Regenerate the auth schema and add a console migration, as in C0. The session
  table cannot serve this: expired sessions are purged hourly. Show it on the Members page too.
- UI: an `opsCan(role, action)` helper next to `tenantCan`; mutating controls hidden for auditors; the
  `/ops` route guard accepts both roles.

**Tests:** the isolation suite gains the auditor (every `/ops` mutation refused in the console and with
403 in platform-api; reveal refused); last-operator guards; Playwright: invite an auditor, sign in, see
the dashboards and the audit log, find no action buttons.

## C10 — Verification dashboard: proofs and face checks (feedback 6, 7, part of 1)

**platform-api** (`src/http/routes/stats.ts`; reuse `daysQuery`, `scalar` and the day-spine pattern of
`activitySeries`)
- New `GET /v1/stats/verification?days=` (console principal only, `CONSOLE_ONLY_TAG`). A day counts what
  *started* that day, by its current outcome (the C8 rule).
  - `proofs`: totals (requested, verified, failed, abandoned, in flight); a daily series of the same;
    the top 10 templates with requested / verified / failed; how often a conditional rule required a
    check (`proofs.biometric_condition`).
  - `faceChecks`: gates by status, split issuance / proof; a daily series (passed, failed, expired);
    rejection reasons counted per failed attempt (`liveness_below_threshold`, `match_below_threshold`,
    `no_face`, `vendor_failed`, `vendor_expired`, from `exchange_gate_events`); attempts needed to pass;
    liveness and match score histograms in ten buckets; the tenant's current default thresholds.
  - Scores scrubbed by erasure or retention are null and drop out of the histograms; say so on the page.
- `/admin/stats` gains `verification` (proofs verified / failed, face checks passed / failed in the window).
- New `GET /v1/biometrics/checks` in `src/http/routes/biometrics.ts` (console only), built on
  `listPage`, `pageQuery`, `createdRange`, `oneOrMany` from `src/http/list.ts`. Filters: `status`,
  `recordType`, `reason`, `connectionId`, `q` (external id). Rows: the gate plus the exchange's external
  id and connection id (left joins to `credentials` / `proofs`).
- Migration `0013_verification_indexes`: `exchange_gates (tenant_id, created_at desc, id desc)`,
  `exchange_gates (tenant_id, status, created_at desc, id desc)`,
  `exchange_gate_events (tenant_id, at desc) where type = 'attempt_completed'`.
- No agent-service call in any of these routes (trap 44).

**console**
- `features/dashboard/`: `getTenantVerification` (tenant) and `getTenantVerificationFor` (operator +
  `tenantId`), following `getTenantDashboard` / `getTenantDashboardFor`; one shared
  `verification-dashboard.tsx`, as `tenant-dashboard.tsx` is shared today.
- `components/dashboard/charts.tsx`: stacked outcome columns per day, horizontal reason bars, a score
  histogram with the threshold as a reference line. Status palette for outcomes; hydration-gated in a
  fixed-height box like the existing charts. **Load the `dataviz` skill before writing chart code.**
- Routes `routes/_authed/t/$orgSlug/verification.tsx` and
  `routes/_authed/ops/tenants/$tenantId/verification.tsx`: `RangeTabs`, tabs "Proofs" and "Face checks"
  (`?tab=`). The Face checks tab ends with the paged checks table (`DataTable` + `list-toolbar` filters);
  its row action opens the existing biometric log dialog from `features/tenant-data/panels.tsx`.
- Navigation in `components/shell/use-shell-model.ts`: "Verification" after Exchanges, both sidebars.
- `/ops` dashboard: two tiles (proof success rate, face-check pass rate). Tenant Overview: one tile
  linking to the page. Biometrics off for the tenant: an empty state linking to Biometrics.

**Tests:** `test/stats.test.ts` (seeded gates and attempts: counts, reasons, histogram buckets, zero
days present, API key → 403, null scores ignored), a checks-list test (filters, tenant isolation,
stable pages); Playwright: range and tab in the URL, a reason row filtering the table, the log dialog.

## C11 — Customer activity page (feedback 8)

A "customer" is one connection: credentials and proofs already carry `connection_id`, and both list
routes already filter by it. There is no wallet-to-connection link, so wallets are matched by exact
external id and labelled as such.

- platform-api: `GET /v1/connections/:id/activity` in `src/http/routes/exchanges.ts` (console only):
  the connection view, totals (credentials by state; proofs by state plus verified / failed; face checks
  by status), first seen, last activity, wallets with the same external id (at most 20). The
  `*_connection_idx` indexes cover it.
- console: `routes/_authed/t/$orgSlug/customers/$connectionId.tsx` and the operator twin. Header
  (external id, holder label, state, erased flag), a `StatGrid`, then tabs Credentials / Proofs /
  Face checks: the existing tables from `panels.tsx` and C10's checks table with `connectionId` fixed
  (add the parameter to `features/tenant-data/list.schemas.ts` and `list.params.ts`).
- Entry points: an "Activity" row action on the Connections table, and the connection cell of the
  credential and proof tables.
- Operators see personal data masked here as everywhere else.

**Tests:** the activity route (totals, another tenant's connection → 404); Playwright from a connection
row to the page and its tabs.

## C12 — Export: Excel and CSV (feedback 15, first step)

**Both formats, from one code path** (owner question, 2026-10-11). Excel is what staff open; CSV is what
other systems read (a SIEM for the audit log, scripts, a data warehouse).
- Why not CSV alone: Excel damages it on open. Long numeric references lose leading zeros or turn into
  `1.23E+15` (account-style external ids), dates are re-read by the PC's locale, and some locales expect
  `;` as the separator. A real `.xlsx` has typed cells, so none of that happens.
- Why not Excel alone: it is the wrong input for other systems, and CSV costs almost nothing extra.
- Cost of adding Excel: one write-only library in the console, loaded only when someone exports, and
  about half a day. Everything else (rows, permission, cap, audit entry) is shared.

- `console/src/features/export/export.functions.ts`: `exportTenantList` and `exportOpsList`, ordinary
  guarded server functions. Each validates the list's own search schema, reads pages of 100 with the
  existing `allPages` (`lib/list-search.ts`), and returns typed `{ filename, columns, rows }` (each
  column says text, number or date-time). Above 10,000 rows it returns the total, and the UI asks for
  narrower filters.
- The file is built in the browser from those rows and downloaded from a Blob, so there is no binary
  transport and no new unguarded server route. Check the nonce CSP accepts it (the staging specs fail
  on any violation).
  - `console/src/lib/export/csv.ts`: RFC 4180 quoting, CRLF, UTF-8 BOM, and a formula guard (a cell
    starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`).
  - `console/src/lib/export/xlsx.ts`: one sheet, bold frozen header row, ids and references as **text**
    cells, timestamps as date cells (UTC, stated in the header), column widths set. Text cells are not
    evaluated, so no formula guard is needed there.
  - Library: a small write-only xlsx writer, imported dynamically so it is a separate chunk.
    Candidate `write-excel-file`; decide at build time after checking maintainer, licence, install
    scripts and `npm audit` (as was done for `cn`), then pin exactly. Avoid the npm `xlsx` package
    (stale on npm) and prefer not to take `exceljs` (large dependency tree) unless the candidate fails.
- Lists: connections, credential exchanges, proof exchanges, wallets, face checks, webhook deliveries
  (no bodies), and the audit log (with `changes`, which is already redacted).
- Columns are the table's columns: never attribute values, disclosed values or webhook bodies. An
  operator's export stays masked.
- Permission: new `export: ['run']` in `lib/permissions.ts` for owner and admin; operators and auditors
  may export. Every export records `export.run` (list, format, filters, row count) through C13.
- UI: an "Export" menu (Excel / CSV) in `components/data-table/list-toolbar.tsx`, hydration-gated.

**Tests:** `csv.test.ts` (quoting, formula guard, BOM); `xlsx.test.ts` (a reference with leading zeros
and a 16-digit one come back as the same text, a timestamp as a date); the cap; member refused;
Playwright downloads a filtered export in each format, checks the header row, and finds the audit
entry. `check:client` stays clean and the login page's bundle does not grow.

---

## Documents
- New `implement/22-console-feedback.md`: the 17-item gap table, this plan, set 2 and the "not now"
  list. Findings in `implement/23-console-feedback-findings.md`.
- `implement/4-init-post-phase-0.md`: §10 entry, §2.6 and §6 (auditor role, append-only audit).
- Dated back-notes in `implement/11-phase-4.md` (C1 audit, C3 operators, C8 dashboards, C9 "CSV export"
  out-of-scope line, now delivered as Excel and CSV).
- `services/platform-api/docs/data-protection.md`: staff sign-in IP addresses are in the audit; exports.
- `infra/runbooks/console.md`: the auditor role, deleting an operator, the last-operator guard.
- Regenerate `openapi.json` (path count must stay the same: every new route is console-only) and
  `openapi.console.json`; `npm run openapi:client` in the console.

## Kept for later — set 2 (needs owner decisions; about 2–3 weeks)
After the `v0.4.0` release (owner, 2026-10-12).
- **Maker–checker (4):** one approver, for a fixed list of sensitive changes (biometric thresholds and
  provider, webhook endpoint, API keys, roles, retention). No multi-level chains.
- **Security events (9, part of 1):** biometric lockouts, "live but wrong face", repeated declines, with
  an open / reviewed status. Built on C10's checks list. Not a fraud suite: the bank's own fraud system
  sees the business data.
- **In-console notifications (10, 11):** a bell plus mail, fed by the attention lists and the security
  events.
- **Audit log period (12):** its own retention period per organisation on the Data protection page (proposed default 2 years, not below 1), separate from the 90-day period for end users' data; the reasoning is in the findings, "Open, for the owner" 1.
- **System health page for operators (17, part of 10):** service status and firing alerts read from
  Prometheus and Alertmanager; a read-only "what is running" panel (covers the useful part of 16).

## Not now, with the reason
- **Location analytics (14):** a new category of personal data, against the privacy model. Only on a
  contractual demand, and then at country level, taken when a face-check session starts.
- **A full PAM product (5):** the in-app controls exist; a self-hosting bank uses its own PAM for server
  access. Small additions fit set 2 (sign-in alerts, access review from C14's last sign-in).
- **Custom role builder (2):** fixed roles plus the auditor cover the need.
- **Multi-level approval (4):** one approver first.
- **Editable platform settings (16):** they hold secrets and need restarts.
- **Scheduled PDF or compliance reports (15):** wait for a named report; Excel and CSV exports come first.
- **Tamper-evident hash chain on the audit (12):** after the append-only trigger, if an auditor asks.
- **FaceTec "3D" liveness provider (7):** the provider port exists; a separate phase if required.
- **Tenant suspension:** not in the checklist; raise it with the customer.

## Verification
- **Unit:** platform-api `npm test` and `tsc --noEmit`; console `tsc`, Vitest, `vite build`,
  `check:client`. The data-boundary scan must cover every new server function.
- **Local e2e:** console Playwright against a local platform-api (the recipe used for C8/C9), with new
  specs for the audit events, the auditor, the Verification page, the customer page and the export.
- **Charts:** screenshots at 1280 and 390 px, light and dark; no horizontal overflow.
- **Queries:** `EXPLAIN (ANALYZE)` of the verification stats and the checks list on synthetic gates
  (50 k), as C9 did; no sequential scan of `exchange_gates` or `exchange_gate_events`.
- **Staging:** tag `v0.4.0-rc.1`, deploy the bundle, then `smoke:platform-credo`,
  `smoke:biometric-credo` (30/30) and `e2e:staging`. Afterwards check by hand that the Verification page
  shows the smoke's passes, failures and lockout with their reasons, that the smoke's connection has a
  customer page, that an export downloads, and that the audit log holds the sign-ins of the run.
- **Outside:** `api.` with `X-Console-Token` still 404; `POST /admin/audit/events` unreachable from the edge.
