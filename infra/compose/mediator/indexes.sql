-- Secondary indexes for the mediator's databases (Phase 7 review M18).
--
-- Credo drizzle-storage 0.6.0 creates none: every inbound message (each wallet's 10 s PickUpV1
-- poll included) scanned "Did" and friends in full. Array/jsonb containment is only indexable
-- because the -p4 image patches drizzle-storage to emit native `column @> value` instead of
-- `to_jsonb(column) @> to_jsonb(array[...])` (to_jsonb is not IMMUTABLE, so that form can never
-- use an index). The predicates below are the ones captured from staging with statement logging
-- on 2026-09-22.
--
-- Idempotent and online: IF NOT EXISTS + CONCURRENTLY (psql runs each statement in its own
-- transaction when given this file with -f; CONCURRENTLY refuses to run inside one). Applied by the
-- one-shot `mediator-indexes` service after mediator-1 is healthy, as the `mediator` role, which
-- owns these tables.

\connect drizzle

-- Hot path: the recipient DID of every inbound envelope (role 'received' / 'created').
create index concurrently if not exists "12id_did_recipient_key_fingerprints_gin" on "Did" using gin (recipient_key_fingerprints jsonb_path_ops);
create index concurrently if not exists "12id_did_did_idx" on "Did" (context_correlation_id, did);
-- Phase 9 W4 load test (2026-10-04): DidRepository's lookup by DID is
-- `(alternative_dids @> $2 OR did = $3) AND role = $4`; without this index the OR forced a sequential
-- scan of "Did" (88 ms at 6k rows, every poll), and the mediator timed out from 1k polling wallets.
create index concurrently if not exists "12id_did_alternative_dids_gin" on "Did" using gin (alternative_dids);

-- Connection by our DID (+ their DID), by out-of-band id (platform wake mapping, review M10), by id.
create index concurrently if not exists "12id_connection_did_idx" on "DidcommConnection" (context_correlation_id, did);
create index concurrently if not exists "12id_connection_out_of_band_id_idx" on "DidcommConnection" (out_of_band_id);
create index concurrently if not exists "12id_connection_id_idx" on "DidcommConnection" (id);

-- Forward routing: the mediation whose recipient keys contain the forward's `to` key.
create index concurrently if not exists "12id_mediation_recipient_keys_gin" on "DidcommMediation" using gin (recipient_keys);
create index concurrently if not exists "12id_mediation_connection_idx" on "DidcommMediation" (context_correlation_id, connection_id);
create index concurrently if not exists "12id_mediator_routing_fingerprints_gin" on "DidcommMediatorRouting" using gin (routing_key_fingerprints);

-- Connection requests matched to their invitation.
create index concurrently if not exists "12id_oob_recipient_key_fingerprints_gin" on "DidcommOutOfBand" using gin (recipient_key_fingerprints);
create index concurrently if not exists "12id_oob_request_thread_ids_gin" on "DidcommOutOfBand" using gin (invitation_requests_thread_ids);
create index concurrently if not exists "12id_oob_thread_idx" on "DidcommOutOfBand" (context_correlation_id, thread_id);
create index concurrently if not exists "12id_oob_invitation_id_idx" on "DidcommOutOfBand" (context_correlation_id, (out_of_band_invitation ->> '@id'));

\connect message_pickup

-- The pickup take is `(connection_id = $1 OR $2 = ANY(recipient_dids)) AND state = 'pending'`:
-- the OR branch defeats the connection_id index unless recipient_dids is indexed too.
create index concurrently if not exists "12id_queued_recipient_dids_gin" on queued_message using gin (recipient_dids);
create index concurrently if not exists "12id_queued_pending_idx" on queued_message (connection_id, created_at) where state = 'pending';
