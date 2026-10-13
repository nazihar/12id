CREATE TABLE "password_history" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "last_active_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "failed_sign_ins" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "locked_until" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "password_changed_at" timestamp;--> statement-breakpoint
ALTER TABLE "password_history" ADD CONSTRAINT "password_history_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_history_userId_idx" ON "password_history" USING btree ("user_id","created_at");--> statement-breakpoint
-- implement/24: existing passwords count from the day this runs, so none expires at once.
UPDATE "user" SET "password_changed_at" = now() WHERE "password_changed_at" IS NULL;--> statement-breakpoint
-- Open sessions count as active now, so the idle timeout does not end them at the deploy.
UPDATE "session" SET "last_active_at" = now() WHERE "last_active_at" IS NULL;--> statement-breakpoint
-- The current password starts each account's history (it cannot be set again as the next one).
INSERT INTO "password_history" ("id", "user_id", "hash", "created_at")
  SELECT gen_random_uuid()::text, "user_id", "password", now() FROM "account"
  WHERE "provider_id" = 'credential' AND "password" IS NOT NULL;
