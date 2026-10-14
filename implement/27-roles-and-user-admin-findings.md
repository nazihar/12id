# Roles by action, custom organisation roles, user administration: findings

Plan: [`26-roles-and-user-admin.md`](26-roles-and-user-admin.md). Built 2026-10-13 to 2026-10-14. **Released as platform `v0.9.0` on 2026-10-14** (commit `3d23daf`; staging runs `0.9.0-rc.1`).

## Found on the way
1. **The Better Auth CLI drops what it did not generate.** `npx auth generate` rewrote `auth-schema.ts` without the hand-written `password_history` table (implement/24) and without `failed_sign_ins … NOT NULL`. Both were put back by hand before `drizzle-kit generate`. Every future `db:generate` needs the same check, or drizzle would plan to drop the table.
2. **The server API names of dynamic access control** are `auth.api.createOrgRole` / `updateOrgRole` / `deleteOrgRole`; the HTTP paths are `/organization/create-role` etc.
3. **Better Auth itself:**
   - refuses to delete a role a member holds, but not one a pending invitation names (the console checks both);
   - reserves the built-in names;
   - lowercases role names;
   - refuses to grant an action the person does not hold.
   Its `hasPermission` merges a stored role with a built-in role of the same name. The console's `effectivePermissions` does the same, so both agree.
4. **An expired dated disable stays `banned = true` until the next sign-in**, where the admin plugin lifts it (`plugins/admin/admin.mjs:33-49`). `accountState()` reads `banExpires`, so the lists show such an account as active, and the state filter's SQL does the same.
5. **One session per account (implement/24) makes "who is signed in now" a short list**, one row per person. It also means that an owner ending a member's session would sign that person out of their other organisations. So owners only see the list, and they disable the membership instead.
6. **The last owner:**
   - an owner, or a custom role with Manage people, could have disabled every owner, and nobody could then manage the organisation's people;
   - disabling the only enabled owner is refused.
7. **The wording changed from "Ban" to "Disable" and from "Unban" to "Re-enable"**, in the console and in platform-api's approval texts (`operator.unban` summary). The audit event names stay (`account.operator_banned` / `_unbanned`), with "disabled" / "re-enabled" labels.
8. **Writing code through shell one-liners is fragile here.**
   - Git Bash refuses a heredoc that contains backticks.
   - A `node -e` edit turned `\d` into `d` in the disable form's date check. A valid day then failed with "Pick a day."; e2e found it.
   - Scripts now go through the Write tool.
9. **e2e:**
   - a tab click before hydration does nothing, so the operators test opens `?tab=signed-in` by URL;
   - a test that signs in with TOTP needs more than the default 30 s, because it waits for the next code window;
   - `second-person.spec.ts` and `portal.spec.ts` picked the role option `admin`, which is now labelled `Admin`.

## Verified locally (2026-10-14)
- **Console:**
  - `tsc` clean;
  - Vitest **108/108**, including the new role-model tests, the timed-disable and membership-disable rules, and the guard test that now accepts `staffMiddleware(`;
  - `vite build` passes, and `check:client` is clean (12 markers).
- **platform-api:**
  - `tsc` clean and `npm test` **160/160**, including `role.change` (summary, one open request per role, members refused);
  - `openapi.json` is unchanged (35 paths); `openapi.console.json` gains the event types and `role.change`.
- **Console migration `0003`** applied to the local `console` database: `organization_role` with its unique (organisation, role) index, and the three `member` columns.
- **Local e2e** (console under Vite dev, local platform-api on 3510, `12id-p2-postgres`): the whole suite apart from `biometrics` (no biometric-service locally), **18 passed, 1 skipped** (`second-operator`, which needs `OPERATOR_APPROVALS=on`). The new `e2e/roles.spec.ts` (2 tests):
  - a built-in name is refused;
  - "Integrations" (Manage integration and Export) is made and given to an invited member. They can create API keys and export, and cannot change the data period, invite, or open Roles (they are sent to Members);
  - deleting the role while it is held is refused;
  - the owner disables the membership until a day with a note. The member is refused ("Your membership of this organization is disabled.") and sees why on their Account page; the access report counts it;
  - the state filter shows only them, and the CSV export downloads `members-<date>.csv`;
  - "Re-enable here" restores access on the next request;
  - "Signed in now" lists the member under the role's label, with no End session for an owner;
  - the audit has "Role created" and "Member disabled in the organization";
  - operators see the access report, their own live session, and the disabled filter.
- **`second-operator.spec.ts`** with `OPERATOR_APPROVALS=on` (`E2E_OPERATOR_APPROVALS=on`, a platform-api started with the setting): **passed** with `auth.spec.ts`, 3/3. It covers adding an operator held for a second one, then **Disable** with a note (not held) and **Re-enable** held ("Sent for approval: Re-enable …"); the row shows `disabled` and the note. It was skipped in the `v0.8.0` run, so this is its first run with approvals on since `v0.6.0`. One earlier attempt failed before the changed part, with requests left over from a run the machine interrupted; it passed once those were cancelled.

## On staging (2026-10-14, `0.9.0-rc.1`)
The owner said "do the rest by yourself". Commit `3d23daf`; tag `v0.9.0-rc.1` built the nine images by CI.

| Check | Result |
|---|---|
| Deploy | the bundle's one changed file (`runbooks/console.md`) installed, the old one in `/opt/12id/infra.prev-20261014-v090`; `release.env` replaced (previous: `release.env.prev-0.8.0-rc.1`); seven stacks up in 291 s, no failed step |
| Console migration `0003` | applied by console-migrate: `organization_role` present (empty), the `member` columns present (8 memberships, none disabled) |
| The running console | `12id-console:0.9.0-rc.1`; `docker inspect` clean for every platform container (the one match is the demo reference backend's own `WEBHOOK_SECRET`, outside the bundle) |
| `e2e:staging` | **4/4** |
| `console-feedback-check` / `approvals-check` | **36/36** / **19/19** |
| `smoke:platform-credo` / `smoke:biometric-credo` | **PASSED** / **PASSED 30/30** (Claude opened the `-R 3200` tunnel itself this time, and closed it after) |
| By hand, a one-off Playwright script (not committed) | **passed**: the acme-platform owner created a custom role (Manage integration and Export), edited it (Export off), saw the access report on Members, and deleted the role. An operator disabled a throwaway operator (made with console-tools) until a day with a note; the row showed `disabled` and the note, and the database had `banned` with `ban_expires`. With `ban_expires` set back a minute, the list read it as active, the account signed in again (to 2FA setup), and Better Auth had cleared `banned`. "Signed in now" listed the operator; the audit had "Role created", "Role deleted" and "Operator disabled". The throwaway was deleted through the console; no account or custom role is left behind |

**Released as `v0.9.0`** on the same commit; CI added `0.9.0` to the rc's nine digests. Production (W5 step 4) deploys `release-0.9.0.env` and the 0.9.0 bundle. There is no new secret, and the console migration runs by itself.

**MTB gap analysis updated the same day** (`mtb/Gap_Analysis_Sections_2-6.md`, outside this repository):
- 14 rows rewritten: 2.13, 2.15–2.17, 5.2–5.6, 5.3a, 5.3c, 5.3d, 6.78, 6.106. Theme G and the 2.37 remark were updated. Row 5.5 had been stale since `v0.8.0`.
- The scoreboard was recounted from the rows, by a script that first reproduced the earlier numbers.
- Comply rows: 86 Have, 95 Partly, 47 Missing (were 81, 95, 52). Complete is 60% by rows and 69% by MTB's weights (were 57% and 66%). Section 5 went from 41% to 68%.
