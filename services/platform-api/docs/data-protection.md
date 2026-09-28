# Data protection at 12iD

**For:** the organisations that issue and verify credentials with 12iD, and their privacy and legal teams.
**Describes:** what personal data 12iD holds, for how long, and how it is erased. Every statement here describes how the platform behaves today (Phase 7 H1).

## Roles

- **You (the organisation) are the controller** of your users' personal data: the attribute values you issue, the values your users disclose to you, and the reference images you send for biometric checks.
- **12iD processes that data for you** to run the exchanges. It does not use it for anything else.
- **Your users hold their credentials themselves**, in the wallet inside your app. 12iD has no copy of a credential and cannot read the wallet.

## What is stored where

| Where | What | Personal data? |
|---|---|---|
| The Indy ledger (public, append-only) | Your organisation's DID, schemas (attribute *names*), credential definitions | **None.** No attribute value, connection or presentation is ever written to the ledger. That is why the "blockchain versus right to erasure" conflict does not arise. |
| The user's phone | The wallet: keys, credentials, connections | Yes, and it is under the user's control. Removing the app, or the SDK's `reset()`, deletes it. |
| 12iD platform database | For each connection, credential exchange and proof exchange: ids, state, dates, your external id; the attribute values offered; the values disclosed; the holder's label; copies of the webhooks sent to you | Yes: attribute values, disclosed values, holder label, webhook bodies |
| 12iD agent (per-organisation encrypted storage) | The protocol records of each exchange, with the same attribute and disclosed values | Yes |
| 12iD mediator | Encrypted messages waiting for a phone to collect them; which wallet connects when | Message contents are encrypted end to end and unreadable to 12iD. The mediator sees traffic metadata: which wallet, when, and message sizes. An open app polls every 10 seconds. |
| Biometric gate (optional) | The reference image you send, for the duration of the check only; then scores, decisions and the vendor's session id | Face images: **deleted when the check is decided or expires**, never logged, never sent in a webhook. Scores and vendor session ids: yes, until erased. |

**Your external id** (the `externalId` you send with commands) and your wallet ids stay with the records so you can find them. **Do not put personal data in `externalId`**; use your own opaque reference.

## Retention

Personal data of a finished exchange (state `done`, `abandoned` or `declined`) is kept for the **retention period**, and then erased automatically:

- credential attribute values;
- disclosed proof values;
- the bodies of the webhooks sent to you, older than the period;
- biometric scores, vendor session ids, and 12iD's copy of the check;
- the agent's protocol records and the messages stored with them.

**The default is 90 days.** Owners and admins can change it in the console (Data protection). Set **0** to keep the data until you erase it yourself. Exchanges that are still running are never touched.

After erasure **the record stays**, with its id, state, dates, your external id and whether it was verified. Your lists, dashboards and audit history keep adding up; the record shows *Personal data erased* with the date. The validity date of an issued credential (its `expiresAt`) is kept too: it is not personal data, and it drives the "credentials expiring" figures.

## Erasing on request

When a user asks you to erase their data, erase it at 12iD from your backend or from the console:

| What | API | Console |
|---|---|---|
| One credential exchange | `POST /v1/credentials/{id}/erase` | Exchanges → Credential exchanges → Erase |
| One proof exchange | `POST /v1/proofs/{id}/erase` | Exchanges → Proof exchanges → Erase |
| **Everything about one person** (their connection with you, and every exchange on it) | `POST /v1/connections/{id}/erase` | Exchanges → Connections → Erase |

- The data goes from every place in the table above, as with retention. It happens immediately.
- An exchange that is still running answers **409**: wait until it finishes or let it be abandoned, then erase.
- Erasing a connection also closes it, so the user can no longer reach you through it.
- A **`record.erased`** webhook tells your backend, for every erased record. It says who started it: your API key, a member of your organisation, or a 12iD operator.
- Every erasure made on request is listed in the console's **erasure log**: who, when, which record, and why. The data itself is never logged.
- Repeating an erasure is harmless.

To complete the user's request, also delete your own copies (the data you received in webhooks and in API responses) and tell the user how to remove the app or reset the wallet.

## What erasure does not do

- **It does not invalidate an issued credential.** 12iD v1 does not support revocation. A credential stays usable by the user until its `expiresAt` passes, even after you erased your records of it. Choose expiry periods with this in mind. If you need to invalidate credentials early, talk to us: it requires new credential definitions.
- It does not change the ledger. The ledger never held personal data.
- It does not reach into the user's phone. The wallet is the user's.

## Access by 12iD staff

- 12iD operators administer the platform across organisations. In the operator console, **attribute values, disclosed values, holder labels and webhook bodies are masked.**
- An operator who needs to see them to answer a support request must give a reason. The reveal is recorded, with the reason, in the audit log.
- Operators erase data only on your request. They must enter a reason, and you receive the `record.erased` webhook.
- An API key created for you by an operator is marked *Created by operator* in your API keys list, and your owners are told by e-mail.
- The console keeps sign-in records only while they are live: expired sessions and verification codes are deleted hourly.

## Biometric checks

If you use the optional biometric gate, face images are **special-category data** (GDPR Art. 9; BIPA in Illinois).

- You must have the user's consent for the check.
- 12iD keeps the reference image only for the check window (30 minutes by default), encrypted with a key specific to your organisation. It is deleted at the decision.
- The images are processed in **your** vendor account (bring your own AWS account). Your agreement with that vendor covers them.
- Scores and vendor session ids are kept for the retention period, like the rest of the exchange's personal data. The pass or fail decision stays with the record.

## Backups

The platform's databases are backed up nightly, encrypted. Erased data leaves the backups as the backups rotate out (7 days today).

If 12iD ever has to restore a database from a backup:
- records past their retention period are scrubbed again by the next retention pass;
- erasures made on request **after** that backup was taken are lost with it. 12iD will tell you, and you repeat them. Your `record.erased` webhooks list what you erased.
