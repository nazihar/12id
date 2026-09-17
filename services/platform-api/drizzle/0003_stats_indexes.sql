CREATE INDEX "connections_tenant_created_idx" ON "connections" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "connections_tenant_state_idx" ON "connections" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "credentials_tenant_created_idx" ON "credentials" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credentials_tenant_state_idx" ON "credentials" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "proofs_tenant_created_idx" ON "proofs" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "proofs_tenant_state_idx" ON "proofs" USING btree ("tenant_id","state");