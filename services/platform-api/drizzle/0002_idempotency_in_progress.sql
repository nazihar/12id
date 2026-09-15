ALTER TABLE "idempotency_keys" ALTER COLUMN "status_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "response_body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
-- Rows written before this migration were stored only after their response: they are complete.
UPDATE "idempotency_keys" SET "completed_at" = "created_at" WHERE "completed_at" IS NULL AND "status_code" IS NOT NULL;
