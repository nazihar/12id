-- W4 load test, cleanup step 2 (after cleanup.ts revoked the run's wallets). Run on the VM against the
-- platform database as its owner, with the load tenant's id:
--   psql … -v tenant=<uuid> -v phase=A [-v confirm=1] -f cleanup.sql
-- Phase A ages the revocation past WALLET_REVOKED_GRACE_DAYS (30), so the next hourly sweep removes
-- each mediation through the mediator's DELETE /admin/connections/:id (review M10), the path a real
-- revoked wallet takes. Phase B, once every row has mediation_removed_at, deletes the synthetic rows.
-- Only a tenant whose name starts with 'load-' is touched. Without -v confirm=1 it rolls back.

\set ON_ERROR_STOP on
begin;

select id, name from tenants where id = :'tenant' and name like 'load-%';

update wallets w set revoked_at = now() - interval '31 days'
  from tenants t
 where :'phase' = 'A'
   and t.id = w.tenant_id and t.id = :'tenant' and t.name like 'load-%'
   and w.revoked_at is not null and w.mediation_removed_at is null;

delete from wallets w using tenants t
 where :'phase' = 'B'
   and t.id = w.tenant_id and t.id = :'tenant' and t.name like 'load-%'
   and w.mediation_removed_at is not null;

select count(*) filter (where w.revoked_at is null) as not_revoked,
       count(*) filter (where w.revoked_at is not null and w.mediation_removed_at is null) as waiting_for_sweep,
       count(*) filter (where w.mediation_removed_at is not null) as mediation_removed
  from wallets w join tenants t on t.id = w.tenant_id
 where t.id = :'tenant' and t.name like 'load-%';

\if :{?confirm}
commit;
\else
\echo 'dry run, rolled back: add -v confirm=1 to apply'
rollback;
\endif
