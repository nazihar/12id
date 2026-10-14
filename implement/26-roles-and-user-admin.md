# Roles by action, custom organisation roles, user administration: plan

**Status:** built 2026-10-13 and passing locally. It ships as platform `v0.9.0`. Evidence: [`27-roles-and-user-admin-findings.md`](27-roles-and-user-admin-findings.md).

## Context
- **2026-10-13: the owner chose MTB theme G (roles and user administration) as the next work**, after `v0.8.0`. The theme is in `mtb/Gap_Analysis_Sections_2-6.md` §4, rows 2.15–2.17, 5.1–5.7 and 6.78–6.127.
- **The same day, the owner redirected it:** "don't take MTB's requirement too literally for now. Simplify the roles and their actions, and leave room for dynamic role and access control."
- **The first draft added a Security Analyst role and an admin-only role.** One overlapped with what operators already do, and the other's name collided with the organisation's `admin`. Neither is built.

Decided by the owner, 2026-10-13:
1. **Scope:** the groundwork plus custom roles in this release.
2. **Where:** organisations first. The operator area keeps its two roles, but its checks move to actions too.
3. **An owner's disable** affects that organisation only.
4. **Profile fields:** left out for now.

## The model
**Every console check asks for an action, never a role name.** A role is a name for a set of actions.

The portal has seven actions (`lib/permissions.ts`, `PORTAL_ACTIONS`). Each maps to Better Auth statements:

| Action | Statements | Covers |
|---|---|---|
| View | `ac: [read]` | Every page of the organisation (comes with membership) |
| Manage people | `member: [create, update, delete]`, `invitation: [create, cancel]`, `ac: [create, update, delete]` | Invite, role, disable, remove, unlock, password link, roles |
| Manage integration | `apiKey`, `webhook`, `exchange: [create]` | API keys, the webhook, connection invitations |
| Manage setup | `organization: [update]`, `catalogue`, `template`, `biometrics`, `retention`, `approval: [configure]` | Catalogue, templates, face checks, periods, the approvals switch |
| Erase personal data | `exchange: [erase]` | |
| Export | `export: [run]` | |
| Approve changes | `approval: [decide]` | |

The built-in roles are unchanged and locked:
- **Owner:** all seven.
- **Admin:** all except Manage people.
- **Member:** View only.

**The operator area** has four actions (`STAFF_ACTIONS`). There is no editor yet; the map is the room for one:

| Action | What it allows | Held by |
|---|---|---|
| `view-tenants` | Read every organisation (masked), the audit log, health | Operator and auditor |
| `operate` | Create organisations and owners, change setup, retry | Operator only |
| `manage-staff` | Staff accounts | Operator only |
| `reveal` | Unmask personal data with an audited reason | Operator only |

**platform-api never sees a custom role.** The console sends the nearest built-in role as `x-console-role` (`baseRoleFor`):
- `owner` if the role has Manage people;
- otherwise `admin` if it has any change action;
- otherwise `member`.

platform-api's own checks then act as a ceiling: members change nothing, and only owner and admin decide approvals. The console checks the exact actions first. platform-api's role list did not change.

## As built
**Console:**
- **`lib/permissions.ts`:** `PORTAL_ACTIONS`, `canDo`, `mergePermissions`, `permissionsForActions`, `actionsOf`, `baseRoleFor`, `builtInPermissions`; `STAFF_ACTIONS` and `staffCan`. `tenantCan(role, …)` is gone.
- **`server/permissions.server.ts`:** `effectivePermissions(organizationId, roles)` merges the built-in and custom roles the way Better Auth's `hasPermission` does.
- **`server/middleware.ts`:**
  - `tenantMiddleware(permissions)` checks the effective permissions, refuses a disabled membership, puts `permissions` in the context and sends the base role;
  - `staffMiddleware(action)` replaces the role lists; `operatorReadMiddleware` is `view-tenants` and `operatorMiddleware` is `operate`, so the 67 call sites stay;
  - staff account changes use `staffMiddleware('manage-staff')`.
- **The organisation context** (`activateOrganization`, `listMyOrganizations`) carries `permissions`, the base `role` and the `roleLabel`. The 17 portal pages ask `canDo(organization.permissions, …)`.
- **Custom roles:**
  - Better Auth `dynamicAccessControl` (at most 20 roles per organisation), with the `label` and `description` additional fields;
  - the **Roles** page (`/t/$orgSlug/roles`, for Manage people) lists the built-in roles (locked, clone) and the custom ones (edit, clone, delete);
  - the editor is a name, a description and the six actions as checkboxes;
  - the stored name is a slug of the label and never changes;
  - delete is refused while a member or a pending invitation names the role;
  - the Members page's role pickers offer every role of the organisation.
- **Held where approvals are on:** `role.change` (create, update, delete) is a new console change type.
- **User administration:**
  - **access report** cards on Operators and Members (`server/access-report.server.ts`, one SQL with `count(*) filter`);
  - a **state filter** (active, locked, disabled, inactive) on both lists;
  - a **"Signed in now"** tab on both. Operators can end a staff session. Owners only see theirs: ending a session would sign the person out of their other organisations too;
  - **disable with a period and a note** for operators (Better Auth `banUser` with `banExpiresIn`) and, for owners, per membership (`member.disabled_at/until/note`). "Ban" is now called "Disable" in the UI;
  - **export** of both lists as Excel and CSV.
- **Migration `0003_roles_and_user_admin`:** `organization_role` with a unique (organisation, role) index, and the three member columns.

**platform-api:**
- the `role.change` approval type;
- seven audit event types: `account.role_created`, `role_updated`, `role_deleted`, `membership_disabled`, `membership_reenabled`, `session_ended`, and the reuse of `operator_banned` with `until`;
- "Unban" is now "Re-enable" in the approval texts;
- OpenAPI regenerated (the customer document is unchanged).

## Not in this release
- custom roles in the operator area (the `STAFF_ACTIONS` map is the hook; they need a small table of our own);
- several roles per person in the UI (the model already merges them);
- profile fields;
- bulk import;
- department or branch scope;
- access reviews.

## Verification
- **Unit:**
  - console Vitest: the built-in roles give exactly their actions, the base role, custom roles from actions, OR and AND, merging, the staff actions, timed disables and membership disables;
  - the guard test accepts `staffMiddleware(`;
  - platform-api: `role.change` (summary, one open request per role, members refused).
- **Local e2e:** `e2e/roles.spec.ts`:
  - a built-in name is refused;
  - "Integrations" (Manage integration and Export) is created and given to an invited member, who can create API keys and export but not change the data period, invite, or open Roles;
  - deleting a role in use is refused;
  - an owner disables the membership until a day with a note, the member is refused and sees it on the Account page;
  - the state filter and the CSV export;
  - re-enable;
  - "Signed in now";
  - the audit entries;
  - operators see the access report and their own session.
- **Staging:**
  - tag `v0.9.0-rc.1` and deploy the bundle (console migration `0003` runs by itself);
  - run `e2e:staging`, `console-feedback-check`, `approvals-check` and both Credo smokes;
  - by hand: one custom role used end to end and one timed disable that lifts.
