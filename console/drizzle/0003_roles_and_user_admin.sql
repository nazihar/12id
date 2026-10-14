CREATE TABLE "organization_role" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"role" text NOT NULL,
	"permission" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp,
	"label" text,
	"description" text
);
--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "disabled_at" timestamp;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "disabled_until" timestamp;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "disabled_note" text;--> statement-breakpoint
ALTER TABLE "organization_role" ADD CONSTRAINT "organization_role_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organizationRole_organizationId_idx" ON "organization_role" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organizationRole_role_idx" ON "organization_role" USING btree ("role");--> statement-breakpoint
-- implement/26: one name per organization. Better Auth checks it before inserting; this closes the race.
CREATE UNIQUE INDEX "organization_role_org_role_unique" ON "organization_role" USING btree ("organization_id","role");
