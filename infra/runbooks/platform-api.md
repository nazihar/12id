# platform-api (Phase 3) — deploy and operate

## Prerequisites on the VM (once)

1. **Read-only role on the mediator's Drizzle database.** The platform maps mediator webhooks to
   wallets by reading `DidcommConnection.out_of_band_id`; nothing else is granted.

   ```bash
   pw=$(openssl rand -base64 33 | tr -d '/+=' | cut -c1-40)
   infra/scripts/deploy.sh mediator exec -T postgres psql -U postgres -d drizzle -v pw="$pw" <<'SQL'
   CREATE ROLE platform_ro LOGIN PASSWORD :'pw';
   GRANT CONNECT ON DATABASE drizzle TO platform_ro;
   GRANT USAGE ON SCHEMA public TO platform_ro;
   GRANT SELECT ("id", "out_of_band_id", "thread_id") ON "DidcommConnection" TO platform_ro;
   SQL
   echo "PLATFORM_RO_PASSWORD=$pw"   # goes into secrets/platform.sops.env
   ```

2. **Secrets.** Generate 40-char tokens with `openssl rand -base64 33 | tr -d '/+='`.

   | File | Key | Notes |
   |---|---|---|
   | `platform.sops.env` | `PLATFORM_ADMIN_TOKEN` | operator bootstrap routes |
   | `platform.sops.env` | `MEDIATOR_WEBHOOK_SECRET` | secret path segment of the receiver |
   | `platform.sops.env` | `MEDIATOR_ADMIN_TOKEN` | **same value** as `mediator.sops.env: MEDIATOR_ADMIN_TOKEN` |
   | `platform.sops.env` | `PLATFORM_RO_PASSWORD` | from step 1 |
   | `mediator.sops.env` | `MEDIATOR_ADMIN_TOKEN` | enables the patched `POST /admin/invitations` |
   | `mediator.sops.env` | `MEDIATOR_WEBHOOK_URL` | `http://platform-api:3500/internal/mediator/<MEDIATOR_WEBHOOK_SECRET>` |
   | `agent.sops.env` | `AGENT_INTERNAL_TOKEN` | already exists; now also gates agent-service's internal API |

   Edit with `SOPS_AGE_KEY_FILE=/opt/12id/secrets/age.key sops infra/staging/secrets/<file>`.

## Deploy order

```bash
cd /opt/12id
# 1. agent-service now requires the internal token (compose.agent.yml INTERNAL_API_TOKEN).
EXTRA_SECRETS="ledger mediator" infra/scripts/deploy.sh agent up -d --build
# 2. mediator image -p2 (admin route + webhook URL). Replicas roll one at a time.
infra/scripts/deploy.sh mediator build mediator-1
infra/scripts/deploy.sh mediator up -d --no-deps mediator-1 && sleep 20
infra/scripts/deploy.sh mediator up -d --no-deps mediator-2
# 3. platform stack.
EXTRA_SECRETS="agent mediator" infra/scripts/deploy.sh platform up -d --build
# 4. edge (new api.<domain> site, /admin/* block on the mediator site).
infra/scripts/deploy.sh edge exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Checks: `curl -s https://api.<domain>/v1/ledger`, `/openapi.json` 200; `/admin/tenants` and
`/internal/x` 404 from outside; `docker compose -p platform ps` healthy; mediator log shows
`Agent listening` after the roll and no `ADMIN_API_TOKEN` complaints.

## Bootstrapping a customer

Normal path since Phase 4: the console (`runbooks/console.md`), Tenants → New tenant. Break-glass
path over an SSH tunnel (`ssh -L 13500:127.0.0.1:3500 …`), with `T=$PLATFORM_ADMIN_TOKEN`
(audited as actor `admin-token`):

```bash
curl -s -X POST localhost:13500/admin/tenants -H "x-admin-token: $T" -H 'content-type: application/json' -d '{"name":"Acme"}'
curl -s -X POST localhost:13500/admin/tenants/<id>/api-keys -H "x-admin-token: $T" -H 'content-type: application/json' -d '{"label":"backend"}'
```

The API key in the response is shown once. Tenant onboarding runs inline (ledger NYM through the
endorser, ~0.5 s); a `failed` tenant can be retried with `POST /admin/tenants/<id>/onboard`.

## Operating notes

- **Webhooks:** `GET /v1/webhook/deliveries?status=dead` per tenant. A dead delivery can be
  retried by the customer (`POST …/retry`). Rows stuck in `sending` are recovered at start.
- **Wake path:** one `wallet.sync_requested` per wallet per 30 s (`WAKE_DEBOUNCE_MS`). The
  mediator webhook fires per queued message and never retries; if the platform is down those
  wake-ups are lost (the holder still collects on its next poll).
- **Outbox lag:** `outbox_cursor.last_id` vs `max(outbox.id)` in `agent_service` — a growing gap
  means the consumer is stuck (check platform-api logs for `outbox poll failed`).
- **Mediator upgrades:** re-apply both patched files (`infra/staging/mediator/patch/`).
- **Backups:** `platform_api` is included in `backup-postgres.sh`; restore as for the agent databases.
