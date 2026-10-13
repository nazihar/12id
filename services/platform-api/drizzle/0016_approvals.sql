CREATE TABLE "change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"type" text NOT NULL,
	"executor" text NOT NULL,
	"apply" text NOT NULL,
	"subject" text,
	"summary" text NOT NULL,
	"method" text,
	"route" text,
	"body" jsonb,
	"payload" jsonb,
	"before" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_by_label" text,
	"requested_by_role" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_by_label" text,
	"decided_by_role" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"applied_at" timestamp with time zone,
	"apply_error" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "approvals_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_requests_tenant_idx" ON "change_requests" USING btree ("tenant_id","requested_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "change_requests_tenant_status_idx" ON "change_requests" USING btree ("tenant_id","status","requested_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "change_requests_open_subject_unique" ON "change_requests" USING btree ("tenant_id","subject") WHERE "change_requests"."status" in ('pending', 'approved') and "change_requests"."subject" is not null and "change_requests"."tenant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "change_requests_open_operator_subject_unique" ON "change_requests" USING btree ("subject") WHERE "change_requests"."status" in ('pending', 'approved') and "change_requests"."subject" is not null and "change_requests"."tenant_id" is null;