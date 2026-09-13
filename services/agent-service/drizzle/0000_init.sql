CREATE TABLE "ledger_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"tag" text DEFAULT '' NOT NULL,
	"schema_object_id" uuid,
	"attributes" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"request" text,
	"endorsed_request" text,
	"action_state" jsonb,
	"qualified_id" text,
	"unqualified_id" text,
	"ledger_seq_no" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"thread_id" text,
	"state" text NOT NULL,
	"previous_state" text,
	"correlation_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"did" text,
	"nym" text,
	"nym_request" text,
	"endorsed_nym_request" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_objects" ADD CONSTRAINT "ledger_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_objects_identity_unique" ON "ledger_objects" USING btree ("tenant_id","kind","name","version","tag");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_objects_qualified_unique" ON "ledger_objects" USING btree ("qualified_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_objects_unqualified_unique" ON "ledger_objects" USING btree ("unqualified_id");--> statement-breakpoint
CREATE INDEX "outbox_undelivered_idx" ON "outbox" USING btree ("id") WHERE "outbox"."delivered_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_record_idx" ON "outbox" USING btree ("tenant_id","record_type","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_nym_unique" ON "tenants" USING btree ("nym");