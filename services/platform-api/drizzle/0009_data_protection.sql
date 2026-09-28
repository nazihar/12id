CREATE TABLE "erasures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"via" text NOT NULL,
	"actor" text NOT NULL,
	"role" text,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "created_by_role" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "erased_by" text;--> statement-breakpoint
ALTER TABLE "console_audit" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "erased_by" text;--> statement-breakpoint
ALTER TABLE "exchange_gates" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proofs" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proofs" ADD COLUMN "erased_by" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "retention_days" integer;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "record_type" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "record_id" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "erasures" ADD CONSTRAINT "erasures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "erasures_tenant_at_idx" ON "erasures" USING btree ("tenant_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credentials_tenant_expires_idx" ON "credentials" USING btree ("tenant_id","expires_at") WHERE "credentials"."state" = 'done';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_record_idx" ON "webhook_deliveries" USING btree ("tenant_id","record_id");--> statement-breakpoint
-- The dashboard's expiry counts read this column from now on, so attributes can be scrubbed (Phase 7 H1).
UPDATE "credentials" SET "expires_at" = to_timestamp(("attributes"->>'expiresAt')::bigint) WHERE ("attributes"->>'expiresAt') ~ '^[0-9]{1,12}$';--> statement-breakpoint
-- Which exchange each existing delivery is about, so erasing a record finds its deliveries.
UPDATE "webhook_deliveries" SET "record_type" = split_part("event_type", '.', 1), "record_id" = ("body"::jsonb->'data'->>'id') WHERE "event_type" IN ('connection.state_changed', 'credential.state_changed', 'proof.state_changed');--> statement-breakpoint
UPDATE "webhook_deliveries" SET "record_type" = ("body"::jsonb->'data'->>'recordType'), "record_id" = ("body"::jsonb->'data'->>'recordId') WHERE "event_type" = 'biometric.check_completed';
