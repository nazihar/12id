CREATE TABLE "console_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"role" text NOT NULL,
	"tenant_id" uuid,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"status_code" integer NOT NULL,
	"request_id" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "console_audit_at_idx" ON "console_audit" USING btree ("at");--> statement-breakpoint
CREATE INDEX "console_audit_tenant_idx" ON "console_audit" USING btree ("tenant_id","at");