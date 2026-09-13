CREATE TABLE "endorsement_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"operation_type" text,
	"author" text,
	"allowed" boolean NOT NULL,
	"reason" text,
	"request_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_bindings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"nym" text NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_bindings_nym_unique" UNIQUE("nym")
);
--> statement-breakpoint
CREATE INDEX "endorsement_audit_tenant_idx" ON "endorsement_audit" USING btree ("tenant_id","created_at");