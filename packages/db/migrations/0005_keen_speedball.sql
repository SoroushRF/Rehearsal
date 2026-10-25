CREATE TABLE "precedent_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"precedent_id" text NOT NULL,
	"version" integer NOT NULL,
	"applies_to" text NOT NULL,
	"kind" text NOT NULL,
	"digest" text NOT NULL,
	"record" jsonb,
	"actor_user_id" text,
	"source_run_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "precedent_events_org_id_precedent_id_version_kind_index" ON "precedent_events" USING btree ("org_id","precedent_id","version","kind");--> statement-breakpoint
CREATE INDEX "precedent_events_org_id_applies_to_index" ON "precedent_events" USING btree ("org_id","applies_to");