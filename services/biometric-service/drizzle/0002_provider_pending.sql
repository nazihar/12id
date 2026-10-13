CREATE TABLE "provider_configs_pending" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"config_ciphertext" "bytea" NOT NULL,
	"public_config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
