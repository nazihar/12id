ALTER TABLE "tenants" ADD COLUMN "rate_limit_per_min" integer;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "mediation_removed_at" timestamp with time zone;--> statement-breakpoint
-- Wallets the wake path already mapped to a mediator connection were connected (review M10).
UPDATE "wallets" SET "connected_at" = "created_at" WHERE "mediator_connection_id" IS NOT NULL AND "connected_at" IS NULL;
