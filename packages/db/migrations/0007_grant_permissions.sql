ALTER TABLE "approval_grants" ADD COLUMN "permissions" jsonb;--> statement-breakpoint
ALTER TABLE "approval_grants" ADD COLUMN "authz_rule" jsonb;