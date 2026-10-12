ALTER TABLE "console_audit" ADD COLUMN "actor_label" text;--> statement-breakpoint
-- The audit and the erasure log are append-only (implement/22-console-feedback.md C13). The service
-- only ever inserts into them; these triggers turn a bug or an injected statement that tries to change
-- or remove a row into an error. They do not stop the tables' owner, who can drop a trigger: the
-- off-site backups are the independent copy.
CREATE FUNCTION "refuse_audit_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;--> statement-breakpoint
CREATE TRIGGER "console_audit_append_only" BEFORE UPDATE OR DELETE ON "console_audit" FOR EACH ROW EXECUTE FUNCTION "refuse_audit_change"();--> statement-breakpoint
CREATE TRIGGER "console_audit_no_truncate" BEFORE TRUNCATE ON "console_audit" FOR EACH STATEMENT EXECUTE FUNCTION "refuse_audit_change"();--> statement-breakpoint
CREATE TRIGGER "erasures_append_only" BEFORE UPDATE OR DELETE ON "erasures" FOR EACH ROW EXECUTE FUNCTION "refuse_audit_change"();--> statement-breakpoint
CREATE TRIGGER "erasures_no_truncate" BEFORE TRUNCATE ON "erasures" FOR EACH STATEMENT EXECUTE FUNCTION "refuse_audit_change"();
