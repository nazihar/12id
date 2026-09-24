-- Hand-added (Phase 4 C9): trigram operator class for the contains searches. pg_trgm is a trusted
-- extension, so the database owner may create it without superuser (checked against pg-roles.sh).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
DROP INDEX "connections_tenant_state_idx";--> statement-breakpoint
DROP INDEX "credentials_tenant_state_idx";--> statement-breakpoint
DROP INDEX "proof_templates_tenant_idx";--> statement-breakpoint
DROP INDEX "proofs_tenant_state_idx";--> statement-breakpoint
DROP INDEX "wallets_tenant_idx";--> statement-breakpoint
DROP INDEX "webhook_deliveries_tenant_idx";--> statement-breakpoint
CREATE INDEX "api_keys_tenant_created_idx" ON "api_keys" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "connections_tenant_state_created_idx" ON "connections" USING btree ("tenant_id","state","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "connections_external_id_trgm_idx" ON "connections" USING gin ("external_id" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "connections_their_label_trgm_idx" ON "connections" USING gin ("their_label" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "console_audit_actor_idx" ON "console_audit" USING btree ("actor","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credentials_tenant_state_created_idx" ON "credentials" USING btree ("tenant_id","state","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credentials_external_id_trgm_idx" ON "credentials" USING gin ("external_id" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "proof_templates_tenant_created_idx" ON "proof_templates" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "proofs_tenant_state_created_idx" ON "proofs" USING btree ("tenant_id","state","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "proofs_external_id_trgm_idx" ON "proofs" USING gin ("external_id" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "wallets_tenant_created_idx" ON "wallets" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wallets_external_id_trgm_idx" ON "wallets" USING gin ("external_id" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_tenant_created_idx" ON "webhook_deliveries" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_dead_created_idx" ON "webhook_deliveries" USING btree ("created_at" DESC NULLS LAST) WHERE "webhook_deliveries"."status" = 'dead';