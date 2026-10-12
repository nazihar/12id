CREATE TABLE "platform_alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"name" text NOT NULL,
	"severity" text,
	"status" text NOT NULL,
	"summary" text,
	"description" text,
	"labels" jsonb NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"first_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "platform_alerts_occurrence_unique" ON "platform_alerts" USING btree ("fingerprint","starts_at");--> statement-breakpoint
CREATE INDEX "platform_alerts_status_idx" ON "platform_alerts" USING btree ("status","last_received_at");