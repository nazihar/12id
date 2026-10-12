ALTER TABLE "tenants" ADD COLUMN "audit_retention_days" integer;--> statement-breakpoint
-- The audit log gets a retention period (implement/22-console-feedback.md C15). The append-only
-- trigger lets exactly one thing through: a DELETE on console_audit inside a transaction that set
-- `app.audit_purge` for itself, which only the retention pass does (src/audit-retention.ts). UPDATE and
-- TRUNCATE stay refused, and so does every change to the erasure log.
CREATE OR REPLACE FUNCTION "refuse_audit_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'console_audit' AND current_setting('app.audit_purge', true) = 'on' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
