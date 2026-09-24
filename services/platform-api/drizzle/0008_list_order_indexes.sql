DROP INDEX "api_keys_tenant_created_idx";--> statement-breakpoint
DROP INDEX "connections_tenant_created_idx";--> statement-breakpoint
DROP INDEX "connections_tenant_state_created_idx";--> statement-breakpoint
DROP INDEX "credentials_tenant_created_idx";--> statement-breakpoint
DROP INDEX "credentials_tenant_state_created_idx";--> statement-breakpoint
DROP INDEX "proof_templates_tenant_created_idx";--> statement-breakpoint
DROP INDEX "proofs_tenant_created_idx";--> statement-breakpoint
DROP INDEX "proofs_tenant_state_created_idx";--> statement-breakpoint
DROP INDEX "wallets_tenant_created_idx";--> statement-breakpoint
CREATE INDEX "api_keys_tenant_created_idx" ON "api_keys" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "connections_tenant_created_idx" ON "connections" USING btree ("tenant_id","created_at" DESC NULLS LAST,"record_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "connections_tenant_state_created_idx" ON "connections" USING btree ("tenant_id","state","created_at" DESC NULLS LAST,"record_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credentials_tenant_created_idx" ON "credentials" USING btree ("tenant_id","created_at" DESC NULLS LAST,"record_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credentials_tenant_state_created_idx" ON "credentials" USING btree ("tenant_id","state","created_at" DESC NULLS LAST,"record_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "proof_templates_tenant_created_idx" ON "proof_templates" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "proofs_tenant_created_idx" ON "proofs" USING btree ("tenant_id","created_at" DESC NULLS LAST,"record_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "proofs_tenant_state_created_idx" ON "proofs" USING btree ("tenant_id","state","created_at" DESC NULLS LAST,"record_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wallets_tenant_created_idx" ON "wallets" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);