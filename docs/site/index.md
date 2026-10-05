---
title: 12iD documentation
---

# 12iD documentation

12iD lets your organisation issue verifiable credentials to your users and verify them, without running any
ledger, agent or wallet infrastructure yourself. Your backend calls the 12iD Platform API; your Android app
holds the user's credentials through the 12iD SDK; 12iD runs everything in between.

## Start here

| Guide | For | What it covers |
|---|---|---|
| [Credential model](credential-model.md) | Product owners, developers | What a credential is, validity and expiry, why there is no revocation, wallet recovery, how to encode values. **Read before designing a schema.** |
| [Platform API guide](api.md) | Backend developers | Credentials, the asynchronous model, the typical flow, webhooks, biometric checks, erasure |
| [API reference](reference.html) | Backend developers | Every route, request and response, from the platform's OpenAPI document ([`openapi.json`](openapi.json)) |
| [Android SDK guide](android-sdk.md) | App developers | Gradle setup from `https://maven.12id.com`, initialisation, offers and proofs, push, backups, biometrics |
| [Data protection](data-protection.md) | Privacy and legal teams | Roles, what is stored where, retention, erasure, backups, hosting, security measures, staff access |

## How the pieces fit

1. In the 12iD console you publish your credential types (schemas) and set your webhook endpoint.
2. Your backend creates a wallet for each app installation (`POST /v1/wallets`) and hands its token to the app.
3. The app, with the SDK, connects to your organisation; your backend offers credentials and requests proofs.
4. Progress reaches your backend by signed webhooks; the user's credentials stay on their phone.

## Environments

| | Platform API | Console |
|---|---|---|
| Production (from go-live) | `https://api.12id.com` | `https://console.12id.com` |

Support and onboarding: contact your 12iD representative.
