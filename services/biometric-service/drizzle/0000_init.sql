CREATE TABLE "checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"purpose" text NOT NULL,
	"provider_id" text NOT NULL,
	"thresholds" jsonb NOT NULL,
	"reference_ciphertext" "bytea",
	"reference_sha256" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_configs" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"config_ciphertext" "bytea" NOT NULL,
	"public_config" jsonb NOT NULL,
	"status" text DEFAULT 'untested' NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "results" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"check_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"liveness_score" real,
	"match_score" real,
	"raw" jsonb NOT NULL,
	"probe_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"check_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"vendor_session_id" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenant_keys" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_keys_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checks_pending_expiry_idx" ON "checks" USING btree ("expires_at") WHERE "checks"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "checks_tenant_idx" ON "checks" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "results_check_idx" ON "results" USING btree ("check_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_check_attempt_idx" ON "sessions" USING btree ("check_id","attempt");