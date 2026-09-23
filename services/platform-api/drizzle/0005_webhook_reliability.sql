ALTER TABLE "webhook_endpoints" ADD COLUMN "previous_secret" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "rotated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_unique" ON "webhook_deliveries" USING btree ("event_id");