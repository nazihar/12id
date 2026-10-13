# Console sign-in rules (MTB theme E): plan

**Status:** released as platform `v0.8.0` on 2026-10-13 (commit `ce84002`, staging on `0.8.0-rc.1`; the owner chose the three decisions below the same day, all as recommended). Evidence: [`25-console-sign-in-findings.md`](25-console-sign-in-findings.md).

## Context
MTB's requirement sheet (`mtb/Part1_Sections_2-6.md`, Section 2) commits us to console sign-in rules the build does not have. The gap analysis (`mtb/Gap_Analysis_Sections_2-6.md` §4 theme E, §5) found the following:
- **Passwords:** 12 to 128 characters is the only rule.
- **Sessions:** a fixed cap from sign-in (12 h for staff, 24 h for everyone else). There is no idle timeout and no limit on parallel sessions.
- **Failed sign-ins:** limited per address, but no lock after wrong passwords.
- **Missing altogether:** captcha, password history, password age, disabling unused accounts, and a strength meter.

MTB's remarks on rows 2.21, 2.25, 2.37 and 2.72 say these values are "hardened server-side by the vendor" and not set from the front end. This plan follows those remarks: one policy for every account, with its values in the deployment's environment. That also gives a self-hosting bank the "configurable" of rows 2.25 and 2.72 without a settings page ("editable platform settings" is on the not-now list, `22-console-feedback.md`).

The owner chose this as the next work on 2026-10-13. All of it is console work, plus a few audit event types in platform-api. It ships as platform `v0.8.0`.

## What changes, by MTB row

| Rows | Rule | Default | Setting |
|---|---|---|---|
| 2.25, 2.72, 2.75, 2.37 (10) | **Idle timeout**, enforced on the server: a session with no user activity for this long is ended. A warning dialog appears 2 minutes before. Staff keep the 12 h and others the 24 h absolute caps | 15 min | `CONSOLE_IDLE_TIMEOUT_MINUTES` |
| 2.24, 2.75 | **One session per account:** a completed sign-in ends the account's other sessions. The other browser lands on the login page with "You signed in somewhere else" | on | none |
| 2.73 | **Closing the browser ends the session:** session cookie without an expiry (Better Auth `rememberMe: false`). Closing just a tab cannot be detected by a server; the idle timeout covers it | on | none |
| 2.21, 2.29 | **Password rules** (server and form, one shared function): at least 12 characters; upper and lower case, a digit and a symbol; no run of 4 or more in sequence (`abcd`, `4321`, keyboard rows) or repeated (`aaaa`); not the email's name part or the person's name; not in a bundled list of common passwords (offline, about 10,000 entries) | as listed | none |
| 2.31 | **Strength meter** under every new-password field, scored from the same rules plus length, with the unmet rules listed. shadcn `Progress` | — | — |
| 2.22 | **The last 3 passwords cannot be used again**, on change, reset and an admin's set | 3 | none |
| 2.34 | **Password age:** after this many days the person must set a new one. Every page sends them to the change form until they do | 90 days | `CONSOLE_PASSWORD_MAX_AGE_DAYS` (0 = off) |
| 2.26, 2.36 | **Lock after wrong passwords:** after N wrong passwords in a row, the account is locked for M minutes. Each failure also adds a growing delay (1 s per failure, up to 5 s). An operator can unlock at once, and a successful sign-in resets the count. The existing lock after 10 wrong second factors stays | 5 → 15 min | `CONSOLE_LOCK_THRESHOLD`, `CONSOLE_LOCK_MINUTES` |
| 2.32, 2.36 | **Captcha** on the login and forgot-password forms: ALTCHA, a proof-of-work check that runs in the browser and is checked by our server. It works without internet access (a bank's premises), with no third party and no tracking | on | none |
| 2.28 | **Disable unused accounts:** an account with no sign-in for this many days is disabled (banned, reason `inactive`) and mailed a notice. An operator re-enables it. Checked daily | 90 days | `CONSOLE_INACTIVITY_DAYS` (0 = off) |
| 2.33 | **Password reset link** lasts 10 minutes, once. An account with an authenticator app must also enter its code on the reset page | 10 min | none |
| 2.37 (5) | **Admin password reset:** an operator (and a tenant owner for its members) can send a reset link from the accounts list | — | — |
| — | **Change password** on the Account page (current + new; ends the other sessions). It does not exist today | — | — |

**Audit (C13):** these new events reach platform-api's audit log the same way sign-ins do now: `auth.locked`, `auth.unlocked`, `auth.idle_sign_out`, `auth.session_replaced`, `auth.password_changed`, `auth.password_expired`, `account.disabled_inactive`, `auth.password_reset_sent`. platform-api's `AUDIT_EVENT_TYPES` gains them.

## How

**Console** (`console/`):
- `src/lib/password-policy.ts` (new, client-safe): `passwordProblems(password, { email, name })` returns the unmet rules and `passwordScore()` returns the meter's score. `auth.schemas.ts` `password` uses it, so every form shows the same messages. The common-password list goes in `src/server/common-passwords.txt` and is checked on the server only, so it stays out of the client bundle; the form shows that result after it is submitted.
- **Better Auth hooks** (`auth.server.ts`):
  - *before* hook:
    - refuse a locked account on `/sign-in/email`, with the same message whether or not the email exists;
    - check the captcha on `/sign-in/email` and `/request-password-reset`;
    - check the password policy and the history on `/reset-password`, `/change-password` and `/admin/set-password`, and in the invitation's `createUser` (server function).
  - *after* hook:
    - count a failed `/sign-in/email` and lock at the threshold;
    - on every new session, reset the count, end the account's other sessions and set `last_active_at`;
    - after a password change, store the old hash in the history and set `password_changed_at`.
  - Built on the 1.7.4 behaviour already read in `auth-events.ts`: an error reaches the after-hook, and a session exists only after the second factor.
  - Set `resetPasswordTokenExpiresIn: 600`.
  - Sign in with `rememberMe: false`; check that the two-factor step keeps it.
- **Idle timeout:** add `session.last_active_at`.
  - `authMiddleware` and `getViewer` end a session idle past the limit (`sessionIdle()` next to `sessionExpired()` in `permissions.ts`).
  - Only a person's activity extends it. A small client hook in the authed layout listens for pointer and key events and calls `touchSession` at most once a minute. Background refetches (dashboards, the approvals count) do not count, or a page left open would never time out.
  - The warning dialog is a shadcn `AlertDialog` with "Stay signed in".
- **Password age:**
  - add `user.password_changed_at` (set to now for existing accounts by the migration);
  - an expired password turns the viewer into "must change password";
  - the `_authed` guard sends them to `/account/password`, and server functions answer 403 except the change itself.
- **Lock:** add `user.failed_sign_ins` and `user.locked_until`. Operators get an "Unlock" action in the operator accounts list, next to ban and unban.
- **Unused accounts:** a daily pass in the existing auth housekeeping timer (`data-protection.server.ts`), using `last_sign_in_at` (C14), or `created_at` for an account that never signed in. It mails the notice. If every operator ends up disabled, `console-tools` still creates one (runbook).
- **Captcha:**
  - `altcha` (widget) and `altcha-lib` (server), both MIT, pinned;
  - the challenge comes from a server function signed with an HMAC key derived from the auth secret (no new secret);
  - each solution is accepted once;
  - check the CSP: the widget uses a Web Worker, so `worker-src` may need `blob:`.
- **Admin reset:** an operator-only server function calls `requestPasswordReset` for the account and audits it. Tenant owners get the same for their members.
- **Migration** `drizzle/0002_sign_in_rules.sql`:
  - `password_history (user_id, hash, created_at)`;
  - the columns above;
  - an index on `user.last_sign_in_at`.
- **Settings:** in `env.server.ts` with the defaults above; passed through `infra/compose/compose.console.yml`, and described in `infra/env/template.env` and `infra/runbooks/console.md`.

**platform-api:** the new event types in `src/http/routes/audit-events.ts`, plus a test. Nothing else changes.

## Not in this plan
- A different policy for privileged users (row 2.21): MTB's remark says one policy. Staff already have a shorter session cap and the authenticator app only.
- Setting these values from the console (rows 2.37 items 7, 9 and 10, declined in the remark).
- SMS for the disabled-account notice (row 2.28 allows mail).
- Keycloak and federation (theme F).

## Owner decisions (decided 2026-10-13: 1 as listed, 2 ALTCHA, 3 temporary only)
1. **Defaults:** idle 15 min, password age 90 days, unused accounts 90 days, lock after 5 wrong passwords for 15 minutes. MTB allowed 10–15 min, 60/90 and 30/60/90 days.
2. **Captcha:** ALTCHA proof-of-work, which needs no internet access and no third party. A picture captcha is the alternative; it is harder for people and screen readers, and bots solve it anyway.
3. **Lock:** temporary only, with an operator able to unlock. MTB asked for "permanently / temporarily"; a permanent lock would let anyone who knows an email address lock that account out.

## Verification
- **Unit:** console Vitest for the password policy (every rule and the meter), the idle and age rules (`permissions.ts`), the lock counter, the history check and the inactivity pass. platform-api test for the event types.
- **Local e2e:** the console Playwright suite against a local platform-api (the C8/C9 recipe). New specs:
  - lock after 5 wrong passwords, then unlock by an operator;
  - idle sign-out with a 1-minute setting;
  - a second sign-in ends the first session;
  - a weak password refused with the meter shown;
  - a reused password refused;
  - an aged password forces the change form;
  - the captcha is solved in the browser.
- **Build:** `vite build`, `check:client` (the password list must not be in the client bundle), CSP check (`e2e/csp.ts`).
- **Staging:**
  - tag `v0.8.0-rc.1`, deploy the bundle;
  - run `e2e:staging` (the staging operator logs in through the captcha), `console-feedback-check`, `approvals-check` and both Credo smokes;
  - by hand: one lock and unlock, one idle sign-out, a second-browser sign-in, an inactivity notice on a test account with its last sign-in set back.
