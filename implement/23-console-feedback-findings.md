# Console feedback, set 1 — findings

**Plan:** [22-console-feedback.md](22-console-feedback.md). **Status (2026-10-12): set 1 (C10–C14) is built and passes locally. Nothing is deployed and nothing is committed.**

| Item | State |
|---|---|
| C13 audit: account events, actor label, append-only | **done, local.** Migration `0012_audit_events` |
| C14 operator accounts: auditor role, edit, delete, last sign-in | **done, local.** Console migration `0001_last_sign_in` |
| C10 Verification page: proof outcomes, face checks, the checks list | **done, local.** Migration `0013_verification_indexes` |
| C11 customer page: everything on one connection | **done, local** |
| C12 export: Excel and CSV | **done, local.** `write-excel-file` 4.1.1 pinned |
| List order (found on the way) | **fixed, local.** Every list page is read from its index again |
| Biometric log without the gate engine (found on the way) | **fixed, local** |
| Final local run | **2026-10-12, all green.** platform-api: `tsc` clean, `npm test` 131/131 (111 before this work), `openapi.json` 34 paths (unchanged), `openapi.console.json` 55 → 59. Console: `tsc` clean, Vitest 75/75 (44 before), `vite build` and `check:client` clean, the Excel writer is a 71 KB chunk of its own. Playwright against a local platform-api, one run: 9/9 (`auth` 2, `export`, `lists`, `ops`, `ops-audit`, `ops-auditor`, `portal`, `verification`). Not run: `biometrics.spec.ts`, any staging smoke, the phone |

Every claim below comes from a local run on 2026-10-11 or 2026-10-12, or a read of the installed source on those dates.

---

## C13 — Audit (done, local)

### What was built
**platform-api**
- `console_audit.actor_label`: the actor's email when it acted. The console sends it URI-encoded in `x-console-actor-label`; `cleanActorLabel` (`src/http/auth.ts`) decodes it, drops control characters and cuts it at 320. A label that cannot be read is dropped, never a reason to refuse the request.
- `POST /admin/audit/events` (`src/http/routes/audit-events.ts`): the console token alone. No actor and no role are required, because a failed sign-in has no user and a member invitation is an owner's act. The break-glass admin token is refused. The row is a `console_audit` row with `method = 'EVENT'` and the event type as its `route`; `detail` goes through the same replacements as a change (`auditDetail`, 2 KB cap).
- `GET /admin/audit`: returns `actorLabel`; `q` also matches it; new `kind` filter (`change`, `sign-in`, `account`, `export`).
- Migration `0012_audit_events`: the column, and triggers that refuse `UPDATE`, `DELETE` and `TRUNCATE` on `console_audit` and `erasures` (`refuse_audit_change()`, SQLSTATE `42501`).

**console**
- `src/server/audit.server.ts` `recordEvent()`: posts the event; logs and continues when platform-api refuses or is unreachable.
- `src/server/auth-events.ts` (the rules, pure) and `src/server/auth-audit.server.ts` (the facts, from the Better Auth hook context): sign-in, failed sign-in, failed second factor, 2FA set up, reset requested, password set, sign-out, invitation accepted.
- Account actions report their own event after they succeed: operator invited / banned / unbanned / signed out everywhere, organization created, member invited / role changed / removed, invitation cancelled.
- `Principal` carries the account's email, and `platformFor` sends it as the actor label on every call.
- The audit page has a Kind filter, shows an event by name ("Sign-in failed") and its result as ok / refused, and prefers the stored email over a lookup. The dashboard's recent-activity list uses the same wording.

### Better Auth 1.7.4, read in the installed source (the plan's first step)
1. **An endpoint that throws still reaches the after-hooks.** `api/dispatch.mjs` catches an `APIError`, stores it as `context.returned` and then runs the after-hooks. So a failed sign-in is visible to a hook; `isAPIError(returned)` tells.
2. **Our after-hook runs before the plugins' own** (`getHooks`: the user hook is pushed first). On `/sign-in/email` for an account with 2FA, `context.newSession` is set when our hook runs, and the two-factor plugin deletes that session right after. A right password is therefore not a sign-in: nothing is reported until the second factor completes.
3. **A second-factor call creates a session only during sign-in.** The same `/two-factor/verify-totp` call from a signed-in user (`verify-two-factor.mjs`, the session branch) creates none: it is the last step of setting up an authenticator app.
4. **`/two-factor/enable` with method `otp` switches email codes on at once** and issues a new session, so that call is the enrolment.
5. **Who failed a second factor** is read the way the plugin reads it: the signed `two_factor` cookie → the verification value → the user. The cookie name is a constant inside the plugin (`plugins/two-factor/constant.mjs`), not a public export; re-check it on a Better Auth upgrade.
6. **Sign-out is reported from the before-hook**: afterwards the session that names the person is gone.
7. `getIP`, `getSessionFromCtx` and `isAPIError` are exported from `better-auth/api`. `emailAndPassword.onPasswordReset` receives the request as its second argument.

### Findings
1. **Account actions were unaudited before this.** Confirmed in the code: `console_audit` was written only by platform-api's response hook, and none of the Better Auth calls reaches platform-api. This is why item 12 of the checklist was "partly", not "mostly".
2. **A request the rate limiter refuses is not audited.** Better Auth answers 429 before any endpoint or hook runs (3 sign-ins per 10 s per address). The attempts that got through are in the audit; the refused burst is only in the access log.
3. **The operator email-code refusal named nobody at first.** We refuse it after Better Auth has accepted the code, consumed the pending-2FA cookie and created a session, so the cookie lookup found nothing. The hook now takes the account from that session before deleting it. Found by reading the first run's rows; the spec checks it.
4. **The triggers do not stop the tables' owner.** The service role owns its tables (Phase 7 H3), so it could drop a trigger. They turn a bug or an injected statement into an error; they are not tamper evidence. The pulled off-site backups are the independent copy. A hash chain is listed under "not now".
5. **Test cleanup needs the triggers off.** `test/helpers.ts` runs `alter table … disable trigger user` around its deletes and re-enables them in a `finally`.
6. **Removing a tenant that has erasure rows now needs a deliberate step.** `erasures.tenant_id` references `tenants`, and the rows can no longer be deleted. No code deletes tenants today; the production runbook's "remove the throwaway tenant" step (W5 step 6) must leave the tenant row or disable the trigger by hand.
7. **A filter menu stays open after a choice** (Base UI radio items do not close it), as on the other lists; the spec presses Escape, as `lists.spec.ts` does.

### Evidence (run, local)
- platform-api: `npm test` **119/119**; `tsc --noEmit` clean; `npm run openapi` → 34 / 56 paths (the customer document is unchanged).
- Console: `tsc` clean; Vitest **55/55** (`auth-events.test.ts` +11); `vite build` and `check:client` clean.
- Playwright against a local platform-api (port 3510): `auth` (2), `ops`, `ops-audit`, `lists`, `portal` **6/6**. `biometrics.spec.ts` was not run (it needs biometric-service; it comes with C10).
- After that run the local audit held 156 rows: 65 changes, each with the actor's email, and 91 events across 12 types (sign-ins 13, failed sign-ins 5, failed second factors 2, sign-outs 3, 2FA set up 2, password set 1, operators invited 3, organizations created 2, member invited / accepted / role changed / removed 1 each). No row held a password: the spec checks the wrong password it typed is not in the failed sign-in's detail.

### Not done yet
- Staging: migration `0012`, both images, and the outside check that `POST /admin/audit/events` answers 404 at the edge.
- The exports' `export.run` event has a type and a test on the platform side; nothing sends it until C12.

---

## C14 — Operator accounts and the auditor role (done, local)

### What was built
- **A second platform role, `auditor`.** It opens everything an operator opens and changes nothing. It is enforced in three places, each on its own:
  - the console: `operatorReadMiddleware` (operator or auditor) on every `GET` server function of the operator area (20 of them), `operatorMiddleware` (operator only) on every function that changes something. `server-functions-guarded.test.ts` now fails if a non-`GET` function carries the read middleware;
  - platform-api: `auditor` is a console role. `requireOperator` and `requireTenantPrincipal` let it through for `GET` and `HEAD` only (403 "auditors are read-only"). Personal data is masked as for an operator, and a reveal header from an auditor is refused (403);
  - Better Auth: the role has no `user` or `session` permission, so the admin plugin's own endpoints refuse it.
- **Like operators:** 12 h sessions, authenticator app only (the email-code refusal covers both roles).
- **The page offers an auditor no change.** `useCanOperate()` hides the controls on the operator pages: new tenant, retry onboarding, create organization, rate limit, API keys, retention, erase, reveal, delivery retry, and everything on the Operators page.
- **Operators page:** role, two-factor, last sign-in and status columns; a role filter; edit (name and role in one dialog), delete, next to ban / unban / sign out everywhere; the invitation takes a role.
- **Delete is a real delete** (`auth.api.removeUser`). The audit keeps the account's email on its rows (C13), and `account.operator_deleted` records name, email and role.
- **Last sign-in:** `user.last_sign_in_at` (Better Auth additional field, console migration `0001_last_sign_in`), set when a sign-in completes, on the same decision that writes the `auth.sign_in` audit event. Shown for operators and for organization members.

### Findings
1. **The "last operator" guard is the "not yourself" guard.** Nobody can edit, delete or ban their own account, and whoever acts is an operator who can sign in, so one always remains. No separate count is needed; two operators demoting each other in the same instant is the only way round it, and the first-operator CLI recovers from that.
2. **Editing and deleting are limited to operator and auditor accounts** (`staffAccount`). Ban, unban and sign-out keep accepting any account id, as before; the page lists only staff.
3. **A refused change by an auditor is not audited**, like any request refused before a principal is set (a wrong token, an organization role on `/admin`). The attempt is in platform-api's request log.
4. **The local platform-api has to be restarted after a role is added**: the first browser run showed an auditor an empty dashboard because the running process still refused the role (401).

### Evidence (run, local)
- platform-api: `console.test.ts` (an auditor reads 14 routes and is refused on 9 kinds of change, nothing created) and `data-protection.test.ts` (masked, reveal refused).
- Console: Vitest `permissions.test.ts` (+3: no admin permission, staff role resolution, the 12 h cap).
- Playwright `ops-auditor.spec.ts`: an operator invites an auditor; the auditor sets a password and an authenticator app (no emailed codes offered), sees the dashboard and the audit log, finds no "New tenant", "Add operator", row action or "Retry"; `/api/auth/admin/list-users` and `/admin/ban-user` answer 403 to it; the operator sees it set up and signed in, renames it, filters by role, deletes it; the auditor's next page is the login page; the audit log still shows its sign-in under its email and the deletion with its details.

---

## C10 — Verification dashboard (done, local)

### What was built
**platform-api** (`src/http/routes/verification.ts`, console principal only, from platform-api's tables only)
- `GET /v1/stats/verification?days=`: proof requests of the window (requested, verified, failed verification, abandoned, in flight), a daily series, the ten busiest templates, how often a conditional rule asked for a check; face checks by outcome, split issuance / proof, a daily series, attempts and why the unsuccessful ones were turned down, attempts needed to pass, liveness and match scores in ten buckets, and the tenant's default thresholds.
- `GET /v1/biometrics/checks`: one row per gated exchange, paged like every list, with the exchange's external id and connection. Filters: outcome, kind, rejection reason (any unsuccessful attempt with it), connection, external id, day.
- `verification` on `/v1/stats` and `/admin/stats`: six headline numbers of the window.
- Migration `0013_verification_indexes` (three indexes on `exchange_gates` and `exchange_gate_events`).
- `gateLog()`: the biometric log of one exchange is now read without the gate engine.

**console** (`src/features/verification/`)
- A **Verification** page in the tenant portal and under the operator's tenant, after Exchanges: tabs Proofs and Face checks, the 7 / 30 / 90-day window, everything in the URL.
- Proofs: four tiles, outcome per day, a table by template.
- Face checks: four tiles, checks per day, rejection reasons (a row filters the table), attempts needed, two score distributions against the minimum, and the checks table with the log of each check and the way to its customer.
- The tenant Overview has a line with the window's numbers and the link; the operator dashboard has two tiles across tenants.

### Chart forms and colour (dataviz method)
| Data | Form | Why |
|---|---|---|
| Headline counts and rates | stat tiles | one number each; the rate is the sub-line |
| Outcome over time | one stacked column per day | part-to-whole per day; three or four states |
| Rejection reasons | ranked bar list (plain markup) | magnitude of at most five named things; each row has its label and number, and is a button |
| Score spread | ten columns with a marked minimum (plain markup) | a distribution against one line; needs no chart library and renders on the server |
| By template, the checks | tables | the records behind the numbers |

- Outcomes are **states**, so they take the status colours already validated in C8 (`--status-good / -warning / -critical`), not a categorical slot. A cancelled check has no outcome and takes the neutral (`--chart-4`).
- Validator on the four against the card surfaces (2026-10-11): separation passes in both modes (CVD ΔE 9.3 light / 11.3 dark, normal vision 18.7 / 23.0). Yellow on white is 1.83:1, the warning C8 already carries; the legend, the tooltip values and the tables relieve it. The lightness-band and chroma checks fail by construction (they describe a categorical palette, which a status set with a neutral is not).
- The failed and abandoned proofs share one column segment ("Not verified"), and failed and expired checks another; the tiles give the split. That keeps the columns to the validated colours.
- Looked at in light and dark at 1280 px and at 390 px: no label collision, no sideways overflow (`scrollWidth === innerWidth` in the spec); the legend follows the stack, and the top segment of each column is the rounded one.

### Findings
1. **The biometric log needed the gate engine to be read.** Without biometric-service configured, `/v1/…/biometric-log` answered an empty log although the rows exist. A deployment that had used the gate and then ran without the service would have lost sight of its logs. Fixed: the log is a plain read (`gateLog`). Found because the local stack runs without biometric-service.
2. **Two clocks.** A request or a check counts on the day it started, by its outcome today (the C8 rule). An attempt counts on the day it was made. The page says so, and no figure mixes them.
3. **The thresholds on the score charts are the tenant's default policy.** A template or a credential definition may set its own; each row of the table shows the minimums that applied to that check.
4. **Erased scores drop out of the distributions** (they are null after erasure or retention); reasons and decisions stay, so the reason counts are not affected.
5. **The routes do not depend on biometric-service being configured.** They read platform tables, so they answer zeros on a deployment without the service, and the page shows "Face checks are switched off" instead of an error.
6. **`loaderDeps` needed an explicit type** for a search schema built by two `extend`s (the inferred type was `{}`).

### Query plans (run, 2026-10-11, scratch database: 50,000 gates, 121,363 events, one tenant holding 30,000)
| Query (the large tenant) | Plan | Time |
|---|---|---|
| Gates of a 30-day window by day, kind, status | `exchange_gates_tenant_created_idx` | 9.9 ms (12,726 rows) |
| Rejection reasons of a 30-day window | `exchange_gate_events_attempts_idx` | 3.6 ms |
| Proofs of a 30-day window by day | index-only on `proofs_tenant_created_idx` | 4.3 ms |
| Checks of one connection | `proofs_connection_idx` → `exchange_gates_record_unique` | 0.1 ms |
| Total of the checks list | index-only | 2.4 ms |
| Checks list, first page | **sequential scan and sort** as first written; `exchange_gates_tenant_created_idx` after the list-order fix below | 6.7 ms → 0.22 ms |

---

## C11 — Customer activity page (done, local)

### What was built
- platform-api `GET /v1/connections/:id/activity` (`src/http/routes/activity.ts`, console only): the connection, counts of its credential exchanges, proof exchanges (with verified and failed) and face checks, its latest activity, and the wallets registered with the same external id (at most 20).
- Console: `/t/$orgSlug/customers/$connectionId` and the operator twin. Four tiles, the wallets card, then tabs for credential exchanges, proof exchanges and face checks: the same paged tables as elsewhere, narrowed to the connection.
- Ways in: an "Activity" action on a connection row, "Customer activity" on a credential, proof or check row.

### Findings
1. **A customer is a connection.** Exchanges carry the connection id; nothing else ties them to one person. The external id is whatever the tenant sent with each call, which the API guide does not require to be the same on a wallet, a connection and an exchange.
2. **Wallets are matched, not linked.** There is no wallet-to-connection link in the platform (the mediator keeps them apart). The card lists wallets with the same external id and says that this is the tenant's own reference.
3. **No merged timeline.** The mirror tables keep an exchange's current state and two timestamps, not each transition; a timeline would have two points per exchange. The three tables give the same facts and page properly for a customer with thousands of approvals.
4. **Operators and auditors see the holder label masked** here as everywhere; the page is titled by the external id.

---

## List order — a defect in every list since C9 (found and fixed 2026-10-12)

**Found** while reading the plan of the new face-checks list: its first page was a sequential scan and a sort, although an index with exactly the list's columns exists.

**Cause.** The list indexes are `(tenant_id, created_at DESC NULLS LAST, id DESC NULLS LAST)`: that is what drizzle's `.desc()` writes in an index. The list routes ordered with drizzle's `desc(column)`, which is a plain `DESC`, and in Postgres a plain `DESC` means NULLS FIRST. The two orders differ on paper (where the nulls go), so Postgres may not read the page from the index, even though the columns are NOT NULL and hold no null. Every list page of every list fetched the tenant's rows and sorted them.

**Why C9 did not see it.** Its `EXPLAIN` table (`12-phase-4-findings.md`) was measured with a hand-written `ORDER BY` that matched the indexes, not with the query the routes build. A correction note is now on that table.

**Effect.** Nothing was wrong in the rows or their order. Each list page cost a scan and a sort of the tenant's rows: on a 30,000-row tenant, 4.3 ms for proofs and 6.7 ms for face checks, growing with the tenant.

**Fix.** `newestFirst(createdAt, id)` in `services/platform-api/src/http/list.ts` writes `… desc nulls last`. Eleven list queries use it: connections, credentials, proofs, wallets (two places), API keys, proof templates, webhook deliveries (tenant and cross-tenant), erasures, face checks. The audit log and the tenants list keep a plain `desc()`: their indexes are ascending and are read backwards, which a plain `DESC` matches.

**Evidence (run).**
- `list.test.ts` "reads every list page in its fixed order straight from the list index, with no sort": for ten list queries built the way the routes build them, the plan (with sequential and bitmap scans switched off, since a test table is tiny) names the list index and has no Sort node; the same query with a plain `desc()` has a Sort.
- Scratch database, 30,000-row tenant, the routes' ordering:

  | Query | Before | After |
  |---|---|---|
  | Proofs, first page | 4.3 ms, seq scan + sort | **0.13 ms**, index |
  | Face checks, first page | 6.7 ms, seq scan + sort | **0.22 ms**, index |
  | Proofs, page at offset 20,000 | 19.3 ms, seq scan + sort | 27.7 ms, index (reads 20,025 entries) |

- A deep page is not faster: offset paging reads every entry before the page either way. That is the known price of page numbers (C9 decision).

---

## C12 — Export: Excel and CSV (done, local)

### What was built
- **One typed row set, two files.** A guarded server function (`features/export/export.functions.ts`) reads the list through the same platform-api routes as the page, 100 rows at a time, with the list's own search schema, and returns columns and rows; each column says text, number or time. The browser builds the file (`lib/export`) and hands it to the download. No route of its own and nothing binary across the boundary.
- **Lists:** connections, credential exchanges, proof exchanges, wallets, face checks, webhook deliveries, and the audit log. An **Export** menu (Excel / CSV) sits at the end of each list's toolbar, in the tenant portal and in the operator's tenant view.
- **Excel** (`write-excel-file` 4.1.1, pinned, imported on demand): references and ids are text cells, times are date cells in UTC (the header says so), the header row is bold and frozen, column widths follow the content.
- **CSV:** RFC 4180, CRLF, UTF-8 byte-order mark; a text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe.
- **What a file may hold** is fixed per list (`export.lists.ts`): the list's columns and identifiers. Never attribute values, disclosed values (names only) or webhook bodies. An operator's or auditor's file is masked like their page: the export never sends a reveal reason.
- **Who:** owners and admins of an organization (new permission `export: ['run']`); operators and auditors. Members read the lists on screen only.
- **Limit:** 10,000 rows per file. A longer list is answered with its size, and the page asks for narrower filters.
- **Audit:** every export writes `export.run` with the list, the format, the filters and the row count (through C13).

### The library (checked before installing, as `cn` was in C0)
| | |
|---|---|
| Package | `write-excel-file` 4.1.1 (registry, 2026-10-12) |
| Licence | MIT |
| Maintainer | one (`catamphetamine`), repository on GitLab |
| Install scripts | none |
| Dependencies | one: `fflate` (zip, MIT, no dependencies) |
| `npm audit --omit=dev` | names neither; the four moderate findings are the existing `drizzle-kit` → `esbuild` chain |
| Use | `write-excel-file/browser`, `writeXlsxFile(rows, { sheet, columns, stickyRowsCount }).toBlob()` |

Not taken: the npm `xlsx` package (stale on the registry) and `exceljs` (a large dependency tree for a writer).

### Findings
1. **Why both formats** (owner question, 2026-10-11). Opening a CSV, Excel turns `00123456789012345` into a number and a sixteen-digit reference into `1.23E+15`, and reads dates by the PC's locale. A workbook has typed cells. CSV stays the format for other systems (a SIEM for the audit log). The test feeds both a reference with leading zeros and a sixteen-digit one and reads them back as the same text from the workbook.
2. **Formula injection is a CSV matter only.** In the workbook a text cell is a string and is never evaluated; the CSV needs the guard, because spreadsheets run a cell that starts with `=`. The guard applies to text cells, which hold what someone else wrote (references, labels, audit details), not to numbers and times.
3. **An export is a read.** It is a `GET` server function with the read middleware, so an auditor can take it; the audit entry it writes is the console reporting about itself, not a change to the platform.
4. **A search that does not fit the list's schema is refused**, not dropped: a dropped filter would export more than the page shows.
5. **The audit page and its export share one read** (`server/audit-log.server.ts`), so the file names actors exactly as the page does.
6. **The download passes the console's nonce CSP.** `export.spec.ts` runs under the CSP guard of the specs and reports no violation for the Blob download.
7. **Not covered by a test:** the 10,000-row refusal (it needs a seeded list of that size; the code path is the first page's total).

### Evidence (run, local)
- Vitest `export.test.ts` (9): CSV quoting, byte-order mark, CRLF, the formula guard on text only; the workbook's cells (text, number, date serial, frozen header, no formula); no attribute or disclosed value in any table; file names; who may export.
- Playwright `export.spec.ts`: as an operator on a seeded tenant, the credential exchanges come out as a workbook (three rows, references as written, no attribute value) and, after a state filter, as CSV (one row, the formula-like reference neutralised); both exports are in the audit log with list, format, filter and row count; the audit log exports itself. `portal.spec.ts`: a member has no Export button, an owner has.

---

## Open, for the owner
1. **Audit retention: separate from the organisation's retention period (owner question, 2026-10-12).**
   - Today the audit log keeps everything. The organisation's retention period (90 days by default) does not touch it: that period scrubs end users' personal data from finished exchanges, and the audit holds none of that (it is replaced before a row is written).
   - The owner asked whether the audit should follow that period, set by the client the same way.
   - **Recommendation: the same place and the same mechanism, but its own period, and a longer one.** The audit exists to outlast the data it describes. With one shared 90-day period, the record that an operator revealed someone's data, or that an owner erased it, would disappear together with the data, and a failed sign-in from three months ago could no longer be looked up. What the audit holds about people is staff data (email, network address, browser), for which one to two years is the usual period.
   - **Proposed, with set 2:** an "audit log" period on the Data protection page next to the existing one, per organisation, default 2 years and not below 1 year; one deployment setting for the entries that belong to no organisation (operator sign-ins, platform changes). The append-only trigger then lets exactly one thing through: the retention job's delete of rows older than the period.
   - **Not in `v0.4.0`:** the log keeps everything, and `data-protection.md` says so.
2. **Tenant suspension** does not exist (statuses are provisioning, ready, failed). Not in the checklist; likely to come up with it.
3. **"3D liveness":** the provider is AWS Rekognition Face Liveness; FaceTec is designed for and not built.
4. **Set 2 comes after this release** (owner, 2026-10-12). It needs decisions before any build: which changes need a second person (maker–checker), what counts as a security event, who is notified of what, and the audit period above.
5. **Not run in this work:** `biometrics.spec.ts` (needs a local biometric-service), every staging smoke, and the phone. Nothing here changes the SDK, agent-service or biometric-service.

## Deploy notes (when this goes to staging)
- One platform release (`v0.4.0-rc.1`): platform-api and console images both change.
- Migrations: platform-api `0012_audit_events`, `0013_verification_indexes`; console `0001_last_sign_in`. All additive. `0012` creates a function and four triggers: the service role owns its tables (H3), so no superuser step is expected; check it on staging as `pg_trgm` was checked in C9.
- After the deploy, check from outside that `POST https://api.<domain>/admin/audit/events` answers 404, with and without `X-Console-Token`.
- The first sign-in after the deploy sets `last_sign_in_at`; before that the lists say "never".
