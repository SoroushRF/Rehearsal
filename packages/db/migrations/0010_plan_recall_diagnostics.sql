CREATE TABLE "plan_recall_diagnostics" (
	"org_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"revision" integer NOT NULL,
	"plan_hash" text NOT NULL,
	"basis_digest" text NOT NULL,
	"diagnostics" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_recall_diagnostics_org_id_plan_id_revision_pk" PRIMARY KEY("org_id","plan_id","revision")
);
