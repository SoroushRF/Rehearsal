DROP INDEX "step_attempts_operation_key_attempt_no_index";--> statement-breakpoint
DROP INDEX "runs_org_id_plan_hash_index";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "requested_by" text NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "requested_by" DROP DEFAULT;--> statement-breakpoint
CREATE UNIQUE INDEX "step_attempts_org_id_operation_key_attempt_no_index" ON "step_attempts" USING btree ("org_id","operation_key","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_org_id_plan_hash_index" ON "runs" USING btree ("org_id","plan_hash") WHERE "runs"."state" in ('approved', 'applying');