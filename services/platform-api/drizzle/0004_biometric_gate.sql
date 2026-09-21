CREATE TABLE "biometric_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"default_policy" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_definition_policies" (
	"tenant_id" uuid NOT NULL,
	"credential_definition_id" text NOT NULL,
	"biometric_policy" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_definition_policies_tenant_id_credential_definition_id_pk" PRIMARY KEY("tenant_id","credential_definition_id")
);
--> statement-breakpoint
CREATE TABLE "exchange_gate_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gate_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"attempt" integer,
	"session_id" uuid,
	"vendor_session_id" text,
	"provider_id" text,
	"liveness_score" real,
	"match_score" real,
	"thresholds" jsonb,
	"decision" text,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "exchange_gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"check_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"thresholds" jsonb NOT NULL,
	"liveness_score" real,
	"match_score" real,
	"reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"hold_reached_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proof_templates" ADD COLUMN "biometric_policy" jsonb;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "capture_modules" text[];--> statement-breakpoint
ALTER TABLE "biometric_settings" ADD CONSTRAINT "biometric_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_definition_policies" ADD CONSTRAINT "credential_definition_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_gate_events" ADD CONSTRAINT "exchange_gate_events_gate_id_exchange_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."exchange_gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_gate_events" ADD CONSTRAINT "exchange_gate_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_gates" ADD CONSTRAINT "exchange_gates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exchange_gate_events_gate_idx" ON "exchange_gate_events" USING btree ("gate_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_gate_events_session_started_unique" ON "exchange_gate_events" USING btree ("session_id") WHERE "exchange_gate_events"."type" = 'session_started';--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_gates_record_unique" ON "exchange_gates" USING btree ("tenant_id","record_type","record_id");--> statement-breakpoint
CREATE INDEX "exchange_gates_thread_idx" ON "exchange_gates" USING btree ("tenant_id","thread_id");--> statement-breakpoint
CREATE INDEX "exchange_gates_pending_expiry_idx" ON "exchange_gates" USING btree ("expires_at") WHERE "exchange_gates"."status" = 'pending';