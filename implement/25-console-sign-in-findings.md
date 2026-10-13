# Console sign-in rules (MTB theme E): findings

Plan: [`24-console-sign-in.md`](24-console-sign-in.md). Built 2026-10-13, all three owner decisions as recommended: defaults 15 min / 90 d / 90 d / 5 → 15 min; ALTCHA; a temporary lock only. **Released as platform `v0.8.0` on 2026-10-13** (commit `ce84002`; staging runs `0.8.0-rc.1`).

## As built

**Console** (`console/`):
- `src/lib/password-policy.ts` (client-safe) holds the password rules and the strength meter.
  - Rules: at least 12 characters, upper and lower case, a digit and a symbol; no run of 4 in sequence (alphabet, digits, keyboard rows, either way round); no character 4 times in a row; not the email's name part or the person's name.
  - The form schemas (`auth.schemas.ts`) and the new `NewPasswordField` (meter: shadcn `Progress`, plus the rules still unmet) use it.
- `src/lib/sign-in-rules.ts` (pure): the idle timeout, password age, lock and delay, inactivity, and the account state shown in the lists.
- `src/server/sign-in-rules.server.ts`:
  - common words: 8,473 base words from SecLists' 10k list (MIT), with look-alike characters read as letters. `common-passwords.data.server.ts` is generated; it is a TS module because the Better Auth CLI loads the auth chain outside Vite;
  - password history: three per account, current included;
  - the lock and unlock;
  - one session per account;
  - idle sign-out and the activity touch;
  - the inactivity pass.
- `src/server/sign-in-hooks.server.ts` holds Better Auth's before and after hooks.
  - Before each call it checks:
    - the captcha on `/sign-in/email` and `/request-password-reset` (browser calls only);
    - a locked account, and adds the growing delay;
    - the policy and the history on `/reset-password`, `/change-password`, `/admin/set-user-password` and `/admin/create-user` (so the CLI and invitations too);
    - the authenticator code at reset.
  - After each call it counts wrong passwords, applies one session per completed sign-in, and keeps the history.
  - `auth.server.ts`: `resetPasswordTokenExpiresIn` 600; the new fields are registered as Better Auth additional fields; `onPasswordReset` records the history.
- `src/server/captcha.server.ts` runs ALTCHA (`altcha` 3.3.0 widget, `altcha-lib` 2.6.0, both MIT, pinned).
  - Challenges are signed with HMAC keys derived from `BETTER_AUTH_SECRET`, so there is no new secret.
  - A payload is accepted once (in-memory store).
  - The work is PBKDF2/SHA-256, cost 1,000, counter 2,000–5,000. In Node that measured 0.3–0.5 s per solve; the README's 5,000 / 5,000–10,000 took 4.6–6.3 s.
  - `src/components/captcha.tsx` gives `useCaptcha()`; `take()` waits up to 10 s for the check, so an early click is not an error.
- The idle timeout:
  - `session.last_active_at` is checked in `authMiddleware` and `getViewer`; an idle session is deleted and audited;
  - only `touchSession` extends it (pointer, key, wheel or touch; at most once a minute), from `components/shell/idle-guard.tsx`, with a warning dialog 2 minutes before;
  - before warning or signing out, the server is asked, so activity in another tab counts;
  - the hourly housekeeping also deletes idle sessions.
- Sign-in sends `rememberMe: false`, so the session cookie ends with the browser. Sign-out clears the query cache.
- An expired password: `getViewer.passwordExpired` sends every page to `/change-password`, which sits outside the authed layout. `authMiddleware` answers 403 meanwhile. **Change password** is in the account menu.
- Operators (`/ops/operators`) and owners (Members) get a Status column (active / locked / inactive / banned), **Unlock** and **Send password link**.
  - Operators re-enable an inactive account with **Re-enable**. It is the unban, held where `OPERATOR_APPROVALS=on`.
  - Owners re-enable only an account the inactivity rule disabled (`reenableMember`), never one a person banned; this is not held.
- Migration `drizzle/0002_sign_in_rules.sql`:
  - `password_history`, `user.failed_sign_ins`, `locked_until`, `password_changed_at`, `session.last_active_at`;
  - backfill: existing passwords count from the migration, open sessions are active now, and each account's current hash starts its history.
- CSP gains `worker-src 'self'`. The widget's worker is a separate same-origin file, using WebCrypto and no WebAssembly.
- Settings, with the defaults: `CONSOLE_IDLE_TIMEOUT_MINUTES` 15, `CONSOLE_PASSWORD_MAX_AGE_DAYS` 90, `CONSOLE_INACTIVITY_DAYS` 90, `CONSOLE_LOCK_THRESHOLD` 5, `CONSOLE_LOCK_MINUTES` 15.
  - They are in `env.server.ts` (blank means the default), `infra/compose/compose.console.yml`, `infra/env/template.env` and `infra/runbooks/console.md` ("Sign-in rules").

**platform-api:** nine audit event types:
- `auth.locked`, `auth.idle_sign_out`, `auth.session_replaced`, `auth.password_changed`, `auth.password_expired`;
- `account.unlocked`, `account.reenabled`, `account.disabled_inactive`, `account.password_link_sent`.

Both OpenAPI documents and the console client were regenerated. Nothing else changed.

## Found on the way
1. **Better Auth's own sign-in limit** is 3 per address within 10 s *of the previous attempt*: the window slides. Its 429 comes before our hooks, so it counts no wrong password. In practice the lock follows only when attempts are at least 10 s apart; a faster script is held by the 429 instead.
2. **The two-factor step creates a provisional session on `/sign-in/email`**, and the plugin removes it after our hook. "One session per account" therefore runs only on a completed sign-in. Otherwise a password alone, without the second factor, would end the real person's session.
3. **The admin CLI (`npx auth create-admin`) goes through `auth.api.createUser`,** so the password policy applies to it. The runbook's `openssl rand -base64 18` could fail it (it may lack a digit or symbol). The command is now `"Tmp-$(openssl rand -hex 12)-Q7!"`; run it again in the rare case the random part holds a sequence or word.
4. **`altcha-lib` declares Express as an optional peer.** Express was already in the tree for dev tools, so `proxy-addr` 2.0.7 (critical advisory) became reachable from a production dependency, and CI's `npm audit --omit=dev --audit-level=high` would have failed. Fixed: `npm audit fix` (no `--force`) moved it to 2.0.8. The 4 remaining advisories are moderate and go through `drizzle-kit`'s esbuild, as before.
5. **Re-enabling an inactive account sets its `last_sign_in_at` to now.** Without that, the next hourly pass would disable it again. The "Last sign-in" column then shows the re-enable time.
6. **A first-password link for an account an operator creates now lasts 10 minutes** (it is the same Better Auth reset link). If it has expired, the person uses "Forgot your password?", or an operator or owner sends a new one from the row.
7. **The reset page asks for the authenticator code only where the account has a verified app.** An account on emailed codes has no second factor independent of the mailbox, so its reset is as before. The next sign-in still needs its code.

## Verified locally (2026-10-13)
- **Unit tests:**
  - console `tsc` clean and Vitest **100/100**, including the new `test/sign-in-rules.test.ts` (policy, meter, timers, lock, inactivity, account state, common words, a captcha round trip with replay and a forged challenge refused) and the env, CSP and guarded-function tests;
  - `vite build` passes and `check:client` is clean (12 markers, including the common-word list and the captcha signing);
  - platform-api **160/160**.
- **Local e2e** (console under Vite dev, local platform-api, `12id-p2-postgres`), against the full suite:
  - 12 passed, including `auth`, `ops-audit` (the audited sign-ins), `portal` (an invitation through the captcha) and `ops-auditor`;
  - `biometrics` failed only because no biometric-service was running;
  - `second-operator` was skipped (it needs `OPERATOR_APPROVALS=on`).
- **The new `e2e/sign-in-rules.spec.ts`, 4/4:**
  - 5 wrong passwords lock the account; an operator unlocks it from the list;
  - a reset link refuses a common (`P@ssw0rd!Xq79`) and a reused password and shows the meter;
  - a second sign-in ends the first session;
  - a session set back 20 minutes in the database is ended on its next request;
  - an aged password opens only the change form.
- **Audit:** platform-api recorded `auth.locked`, `account.unlocked`, `auth.idle_sign_out`, `auth.session_replaced` (11), `auth.password_changed` and `auth.password_expired`.
- **Under the real CSP** (the production build served by `srvx` as in the image; Vite dev sends no CSP), the header carries `worker-src 'self'`. The captcha reached `verified` in 637 ms with no CSP violation and no page error.

## On staging (2026-10-13, `0.8.0-rc.1`)
The owner said "do the rest yourself". Commit `ce84002`; tag `v0.8.0-rc.1` built the nine images by CI.

| Check | Result |
|---|---|
| Deploy | the bundle's three changed files (`compose.console.yml`, `template.env`, `runbooks/console.md`) installed, old ones in `/opt/12id/infra.prev-20261013-v080`; `release.env` replaced (previous: `release.env.prev-0.7.0-rc.1`); seven stacks up in 341 s, no failed step |
| Console migration `0002` | applied by console-migrate; 10 accounts, all with `password_changed_at`, 10 history rows, no session without `last_active_at` |
| The running console | `CONSOLE_*` at the defaults; the CSP carries `worker-src 'self'`; `docker inspect` clean (0 of 33) |
| `e2e:staging` (every sign-in through the captcha; a CSP violation fails a spec) | **4/4** |
| `console-feedback-check` / `approvals-check` | **36/36** / **19/19** |
| `smoke:platform-credo` / `smoke:biometric-credo` (the owner's tunnel, still open) | **PASSED** / **PASSED 30/30** |
| By hand, a one-off Playwright script with a throwaway operator made by console-tools | **14/14**: five wrong passwords (11 s apart) refused, the account locked, the right password refused with the reason; "locked" in the operators list, **Unlock**, then the right password signs in (to 2FA setup); the e2e operator's session set back 20 minutes is ended on its next request and leaves no session; the throwaway operator deleted through the console; no CSP violation |
| Audit on staging | `auth.locked`, `account.unlocked`, `auth.idle_sign_out`, `auth.session_replaced`, `account.operator_deleted` |

**Released as `v0.8.0`** on the same commit; CI added `0.8.0` to the rc's nine digests. Production (W5 step 4) deploys `release-0.8.0.env` and the 0.8.0 bundle; no new secret; the console migration runs by itself; the `CONSOLE_*` values are optional (defaults as above).

**MTB gap analysis updated the same day** (`mtb/Gap_Analysis_Sections_2-6.md`, outside this repository): 13 rows of theme E and the two maker-checker rows (`v0.6.0`) rewritten, the scoreboard recounted from the rows (a script that first reproduced the earlier numbers). Comply rows: 81 Have, 95 Partly, 52 Missing (were 70, 96, 60); complete 57% by rows and 66% by MTB's weights (were 53% and 57%); Section 2 from 58% to 72%. What theme E leaves: a separate policy for privileged users (declined in the remark), the authenticator code at reset for accounts on emailed codes, a delay or captcha on API calls, and a closed tab told from an idle one.
