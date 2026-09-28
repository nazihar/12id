ALTER TABLE "checks" ALTER COLUMN "reference_sha256" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "vendor_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "erased_at" timestamp with time zone;