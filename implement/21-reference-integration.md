# Reference integration: one client backend, one app (plan and status)

**Status (2026-10-10):** the backend is **live on staging at `https://demo.12id.naziharitsolution.com`** (owner go-ahead the same day), with its own tenant, and `smoke:reference-credo` **PASSED** against it. The app is **released as `reference-app-v1`** and downloads from `https://demo.12id.naziharitsolution.com/app`, but it has **not run on a phone yet**. Nothing in the platform or the SDK changed.

| Part | State |
|---|---|
| Backend (`reference/backend`) | built; `tsc` clean, 10/10 tests; **deployed on staging**, healthy |
| Tenant `Acme Bank` on staging | created 2026-10-10: schema `member-card 1.0`, credential definition `9V8saypYnfJrnSodDatDGw:3:CL:2602:default`, template `Approve transfer`, one API key, webhook to `demo.` |
| End to end (`infra/smoke/reference-credo.ts`) | **PASSED** on staging (below) |
| App (`reference/android`) | built; debug and minified release compile against the released SDK 0.2.1 from maven.12id.com; arm64 release 20.8 MB, signed with the reference keystore. **Not run on a phone yet** |
| CI (`ci-reference.yml`) | green on commit `7d1b183` (backend typecheck and tests, app debug build) |
| App release (`release-reference-app.yml`) | **`reference-app-v1` released 2026-10-10**: `/app` redirects to the release in `nazihar/12id-maven` and downloads a 20.8 MB APK, `com.onetwoid.reference` version 1, arm64, signed `CN=12iD reference app` |
| Staging edge site `demo.` | live (Caddy reloaded, certificate issued; the other hosts kept answering) |
| Client README, runbook | `reference/README.md`, `infra/runbooks/reference-demo.md` |

## Why

A client demo needed a stand-in backend on the dev PC behind an SSH tunnel, hand-typed API calls, and a sample app built from source and installed over adb. It was fragile, and nothing shown was code a client could start from.

**Owner decisions (2026-10-10):**
- One backend for a single tenant, simple to point at another tenant.
- One app with a plain use of the SDK; flows start in the app.
- Skins per client later, perhaps with a chooser.
- Kept in this repository under the demo subdomain; moved out later if needed.
- Not mixed into the product: it doubles as the code reference we hand to clients.

## What it is

- **`reference/` is self-contained.** It imports nothing from `services/`, `sdk-android/` or `infra/`, and uses only what a customer gets: the public API with an API key, signed webhooks, the console for setup, and `com.12id:holder-sdk-android` from maven.12id.com.
- **Backend:** Node 22, TypeScript run directly, no dependencies (so no advisories to follow). About 550 lines: `platform.ts` (the 12iD calls), `webhooks.ts` (signature check and what each event does), `server.ts` (routes), `store.ts` (one JSON file), `tenant-info.ts` (prints the ids `tenant.json` needs).
  - Changing the tenant = `tenant.json` (credential definition id, attribute values, a proof template per action) plus the API key and the webhook secret.
  - Routes: `POST /session`, `POST /wallet-token`, `POST /enrol`, `POST /actions`, `GET /actions/:id`, `GET /me`, `POST /webhooks/12id`, `GET /app` (redirect to the APK), `GET /healthz`.
  - The access code at sign-in is the only demo-only part: the app is installable by anyone.
- **App:** `com.onetwoid.reference`, about 730 lines. `Wallet.kt` holds every SDK call; `MainViewModel.kt` the two flows; `Skin.kt` the bank skin as data; `Backend.kt` the calls to our backend.
  - Sign in → the card is offered and accepted → "Send money" → approve → "Transfer approved".
  - Offers and proof requests are shown as dialogs; every wait has a timeout.
- **Hosting:** its own `compose.yml` on the staging VM (`/opt/12id-reference/backend`, the pinned `node:22` base, source mounted read-only), behind one Caddy site. Not in the release bundle, not deployed by `deploy.sh`, no SOPS: its three local files are `.env`, `tenant.json` and `data/store.json`.
- **The organisation's side of a demo is the console** (Exchanges), not a demo page.

## Found while building

1. **A wallet token cannot be re-issued after 24 hours.** `POST /v1/wallets` returns the same wallet with a new token for the same `Idempotency-Key` only while the key is kept (24 h, `docs/api.md`); after that the same call creates a second wallet. The SDK asks the app for the token on every process start, so a backend that follows the guide literally ("always fetch the latest one") creates a new, never-connected wallet each day a phone is used; the hourly sweep revokes them after 7 days. The reference keeps the token it was given and asks again only when the SDK reports a rejection. **Open (platform, owner):** a route that issues a new token for an existing wallet, and a line in the SDK guide.
2. **`.gitignore` ignores `.env*`,** so the backend's template is `env.example`, not `.env.example`.
3. **A sync must never carry the tenant settings** (trap 45 again): `tenant.json` is git-ignored like `.env`; the committed file is `tenant.example.json`, and the backend refuses to start while an id still says `REPLACE`.

## Not done yet

- **Done 2026-10-10 (owner):** the access code is set on the VM, and the keystore's two Actions secrets are in `nazihar/12id`. The owner's code is four digits, which a stranger with the app could guess within the edge's rate limit in about half an hour; acceptable for staging, to be replaced before the link is handed out widely.
- **Owner, in the operator console:** create the console organisation and an owner account for tenant `Acme Bank`. Without it only operators see the tenant, and operators see personal data masked.
- **Then:** the phone run (install from the link, sign in, card, approve; relaunch and the next day: still one wallet), and the tenant swap drill.
- **Extensions, each on its own:** the face check (a selfie at sign-in as the photo on file, a second template with the check required, the AWS add-on); a second skin and a chooser; a flow that starts outside the app (web login by QR, a counter check).
- **Not covered:** a verifier that is a different organisation from the issuer (proof templates resolve only the tenant's own catalogue, `services/platform-api/src/templates.ts`); iOS; push.

## On staging (2026-10-10)

- **Tenant** `eb72d74b-0633-4b00-bf32-8c133b0927c3` (`Acme Bank`), created through the admin route and the console scope inside the platform container. The API key and the webhook secret went straight into the VM's `.env` and were never printed.
- **Backend:** `/opt/12id-reference/backend`, compose project `12id-reference`, `127.0.0.1:3700`, healthy. `.env` and `data/store.json` are mode 600.
- **Edge:** the `demo.` site was added with `caddy validate`, then `caddy reload`, inside the running container. The site files are a directory mount, so a reload reads the new file and nothing restarts. From outside: `/healthz` 200, a webhook without a signature 401, `/app` 302 to the release link, HSTS present; `api.`, `mediator.` and the console still answered.
- **`smoke:reference-credo` PASSED** (a Credo holder stands in for the app; no tunnel, no phone):

  | Check | Result |
  |---|---|
  | Wrong access code | 401 |
  | Two wallet-token requests | one wallet, the same token |
  | Enrol → card | `done` 18.3 s after enrol (the Credo holder's poll cycle, not the SDK's) |
  | Enrol again | already connected, no new invitation |
  | Action | `approved` 6.2 s after the request |
  | Disclosed | only `memberId`, equal to the user's |

  The backend's log shows the three webhooks it acted on: `wallet.sync_requested`, connection completed → offer, proof → approved.
- **Left on staging by the check:** one user, one wallet and one connection in tenant `Acme Bank`.

## Verification so far

- Backend: `npm run typecheck`, `npm test` **10/10**: the full flow against a fake platform (sign-in, one wallet for repeated token requests, enrol, one offer for a repeated webhook, action, approval), declined and invalid proofs, a re-offer after an abandoned one, token refresh and a revoked wallet, webhook signatures (wrong secret, old timestamp, two signatures after a rotation), the store after a restart, and the real HTTP client's headers.
- App: `:app:assembleDebug` and `:app:assembleRelease` (R8) build.
- `tenant-info.ts` against staging with an invalid key answers 401 as expected (a read, nothing changed).
