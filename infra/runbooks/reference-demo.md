# The reference integration on staging (`demo.12id.naziharitsolution.com`)

What it is: `reference/` (a stand-in customer backend and an Android app), described for customers in [`reference/README.md`](../../reference/README.md) and for us in [`implement/21-reference-integration.md`](../../implement/21-reference-integration.md). It is a customer of the platform, not part of it: it is not in the release bundle, is not deployed by `deploy.sh`, and holds no platform secret.

On the VM it lives in `/opt/12id-reference/backend`, with three files that exist only there: `.env`, `tenant.json` and `data/store.json`.

## First deployment

1. **The tenant, in the console** (as a customer would; `reference/README.md` "In the 12iD console"):
   - operator: create the tenant (its name is what a wallet sees as the organisation, e.g. `Acme Bank`) and its organisation with an owner;
   - owner: publish the schema and credential definition, create the proof template, create an API key, and set the webhook endpoint to `https://demo.12id.naziharitsolution.com/webhooks/12id`. Keep the key and the secret for step 3.
2. **The code**, from the dev PC (`core.autocrlf=false`: a plain `git archive` on Windows writes CRLF):
   ```bash
   git -c core.autocrlf=false archive HEAD reference/backend | ssh ubuntu@123.176.58.72 \
     'sudo install -d -o ubuntu -g ubuntu /opt/12id-reference && tar -x -C /opt/12id-reference --strip-components=1'
   ```
   The archive holds neither `.env` nor `tenant.json` (both git-ignored), so a later sync never overwrites the VM's.
3. **The settings**, on the VM:
   ```bash
   cd /opt/12id-reference/backend
   install -m 600 env.example .env && nano .env      # PLATFORM_API_KEY, WEBHOOK_SECRET, ACCESS_CODE, APP_DOWNLOAD_URL
   docker run --rm --env-file .env -v "$PWD":/app:ro -w /app node:22.20.0-bookworm-slim node src/tenant-info.ts   # prints the ids
   cp tenant.example.json tenant.json && nano tenant.json
   mkdir -p data && docker compose up -d
   curl -s http://127.0.0.1:3700/healthz             # {"ok":true}
   ```
   - `APP_DOWNLOAD_URL=https://github.com/nazihar/12id-maven/releases/latest/download/12id-demo.apk`
   - `data/` must be writable by uid 1000 (`ubuntu` on this VM).
4. **The edge.** The site is in `infra/env/staging/caddy/staging.caddy`. Copy that file to the VM, then validate and reload inside the running container. The site files are a directory mount, so a reload reads the new file and nothing restarts:
   ```bash
   docker exec edge-caddy-1 caddy validate --config /etc/caddy/Caddyfile
   docker exec edge-caddy-1 caddy reload --config /etc/caddy/Caddyfile
   curl -s https://demo.12id.naziharitsolution.com/healthz
   ```

## Checking it end to end without a phone

From `infra/` on the dev PC; a Credo holder stands in for the app. No tunnel is needed.

```bash
REFERENCE_ACCESS_CODE=<the access code> node smoke/reference-credo.ts
```

Each run leaves one user, wallet and connection in the tenant.

## Changing the access code

Edit `ACCESS_CODE` in `/opt/12id-reference/backend/.env`, then `docker compose up -d --force-recreate`. People already signed in stay signed in.

## Updating the backend

Run step 2 again, then `docker compose up -d --force-recreate` in `/opt/12id-reference/backend`. Users and their connections are in `data/store.json` and survive.

## Pointing it at another tenant

Replace `tenant.json`, and `PLATFORM_API_KEY` and `WEBHOOK_SECRET` in `.env`; move `data/store.json` aside (its users belong to the old tenant); `docker compose up -d --force-recreate`. Phones use "Reset this app" and sign in again.

Before restarting, check the file:

```bash
docker compose run --rm backend node src/tenant-info.ts
```

It lists each credential definition with its schema's attributes and each template, and ends with "tenant.json fits this catalogue" or the list of what does not fit. `credential.attributes` must name exactly the schema's attributes (without `expiresOn`), with no comma after the last one. The backend runs the same check when it starts and refuses to start on a mismatch; `docker compose logs backend` shows the reason in one line.

## Face checks

1. In the console, as the tenant's owner: **Biometrics** → configure the provider (AWS Rekognition: region and role ARN; the tenant's external id must be in the role's trust policy), pass the connection test, switch the gate on.
2. Set the policy to "always require" on the **active** credential definition and on the proof template the backend uses. `docker compose run --rm backend node src/tenant-info.ts` prints the policy of both.
3. In `tenant.json` set `"photoOnFile": true`, then `docker compose up -d --force-recreate`.
4. On a phone that already has a card: "Reset this app", then sign in. The app asks for a photo, then for the face check before it adds the card, and again before it approves a transfer.

User photos are in `data/photos/` on the VM (mode 600). Delete a file to make that user take a new one.

**Only for some transfers.** To show a face check that depends on the amount:
1. In `tenant.json`, add `"faceCheckParams": ["amount"]` to the `transfer` action, then `docker compose up -d --force-recreate`. Do this first: once the template has a rule, a request without the number is refused.
2. In the console, on the proof template: the face-check button → "Require a face check when…" → `amount ≥ 5000`.
3. `docker compose run --rm backend node src/tenant-info.ts` prints "conditional, decided from amount" and "fits this catalogue".

A transfer under 5000 is then approved without the camera, and the console's Exchanges list shows "not required" for it. Since 2026-10-11 the demo tenant is set up this way; to go back, set the template to "Always require a face check".

## Releasing the app

One-time: a signing keystore, kept offline, and two Actions secrets in `nazihar/12id`.

```bash
keytool -genkeypair -v -keystore reference-app.jks -alias reference -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=12iD reference app" -storepass "<password>" -keypass "<password>"
base64 -w0 reference-app.jks      # → secret REFERENCE_KEYSTORE_B64; the password → REFERENCE_KEYSTORE_PASSWORD
```

Losing the keystore means phones must uninstall the app before a newer build installs.

Each release: tag `reference-app-vN` on `master` (N = the next whole number) and push the tag. `release-reference-app.yml` builds, signs and attaches `12id-demo.apk` to a release in `nazihar/12id-maven`. `https://demo.12id.naziharitsolution.com/app` then downloads it.

- **An SDK update:** change `sdkVersion` in `reference/android/gradle.properties`, then release.
- **From 0.3.0 on,** the SDK checks the genesis signature: add staging's key to the config in `Wallet.kt` (`genesisPublicKeys`), or onboarding fails on staging.

## Running a demo

1. Phone: open `https://demo.12id.naziharitsolution.com/app`, install, sign in with any name and the access code. The card arrives in about 10 seconds.
2. Second screen: the console, signed in as the tenant's owner, on **Exchanges**. Each step on the phone appears there.
3. "Send money" on the phone, approve; the console shows the proof as verified with what was disclosed.
4. To start clean for the next client: "Reset this app" on the phone.

## When something is wrong

| Symptom | Look at |
|---|---|
| Sign-in fails with "access code" | `ACCESS_CODE` in `.env` |
| "Your card did not arrive" | `docker compose logs backend` (a refused platform call is logged there); console → Webhooks → Deliveries for failed deliveries to `demo.` |
| Webhooks answer 401 | `WEBHOOK_SECRET` does not match the endpoint's current secret (rotating it in the console needs the new value here) |
| The backend does not start | its log names the missing setting or the unfilled `tenant.json` |
