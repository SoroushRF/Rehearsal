CREATE TABLE "approval_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"revision" integer NOT NULL,
	"plan_hash" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_session_id" text NOT NULL,
	"roles" jsonb NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "object_bindings" (
	"org_id" text NOT NULL,
	"plan_hash" text NOT NULL,
	"step_id" text NOT NULL,
	"path" text NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "object_bindings_org_id_plan_hash_step_id_path_pk" PRIMARY KEY("org_id","plan_hash","step_id","path")
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"org_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"revision" integer NOT NULL,
	"plan_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_versions_org_id_plan_id_revision_pk" PRIMARY KEY("org_id","plan_id","revision")
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"revision" integer NOT NULL,
	"plan_hash" text NOT NULL,
	"approval_id" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "step_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
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
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "step_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"plan_hash" text NOT NULL,
	"action_id" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plan_versions_plan_hash_index" ON "plan_versions" USING btree ("plan_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "step_attempts_org_id_operation_key_attempt_no_index" ON "step_attempts" USING btree ("org_id","operation_key","attempt_no");--> statement-breakpoint
CREATE INDEX "step_attempts_org_id_plan_hash_action_id_index" ON "step_attempts" USING btree ("org_id","plan_hash","action_id");