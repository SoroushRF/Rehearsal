CREATE TABLE "rehearsal_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"rehearsal_id" text NOT NULL,
	"plan_hash" text NOT NULL,
	"action_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"state" text NOT NULL,
	"request" jsonb NOT NULL,
	"provider_status" integer,
	"error" text,
	"prepared_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "rehearsal_attempts_key_namespaced" CHECK (starts_with("rehearsal_attempts"."operation_key", 'rh_' || "rehearsal_attempts"."rehearsal_id" || '_'))
);
--> statement-breakpoint
CREATE TABLE "rehearsal_bindings" (
	"org_id" text NOT NULL,
	"rehearsal_id" text NOT NULL,
	"step_id" text NOT NULL,
	"path" text NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "rehearsal_bindings_org_id_rehearsal_id_step_id_path_pk" PRIMARY KEY("org_id","rehearsal_id","step_id","path")
);
--> statement-breakpoint
CREATE TABLE "rehearsal_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"rehearsal_id" text NOT NULL,
	"state" text NOT NULL,
	"detail" text,
	"torn_down_at" timestamp with time zone,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rehearsal_reports" (
	"rehearsal_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"plan_hash" text NOT NULL,
	"report" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rehearsal_step_results" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"rehearsal_id" text NOT NULL,
	"action_id" text NOT NULL,
	"result" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rehearsals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"revision" integer NOT NULL,
	"plan_hash" text NOT NULL,
	"scenario_id" text NOT NULL,
	"scenario_version" integer NOT NULL,
	"snapshot_digest" text NOT NULL,
	"policy_id" text NOT NULL,
	"policy_version" integer NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rehearsal_attempts_org_id_operation_key_attempt_no_index" ON "rehearsal_attempts" USING btree ("org_id","operation_key","attempt_no");--> statement-breakpoint
CREATE INDEX "rehearsal_attempts_org_id_rehearsal_id_index" ON "rehearsal_attempts" USING btree ("org_id","rehearsal_id");--> statement-breakpoint
CREATE INDEX "rehearsal_events_org_id_rehearsal_id_index" ON "rehearsal_events" USING btree ("org_id","rehearsal_id");--> statement-breakpoint
CREATE INDEX "rehearsal_reports_org_id_plan_id_index" ON "rehearsal_reports" USING btree ("org_id","plan_id");--> statement-breakpoint
CREATE INDEX "rehearsal_step_results_org_id_rehearsal_id_index" ON "rehearsal_step_results" USING btree ("org_id","rehearsal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rehearsals_org_id_idempotency_key_index" ON "rehearsals" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "rehearsals_org_id_plan_id_index" ON "rehearsals" USING btree ("org_id","plan_id");