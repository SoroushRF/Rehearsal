CREATE TABLE "incidents" (
	"incident_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"window_gte" timestamp with time zone NOT NULL,
	"window_lt" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_window" CHECK ("incidents"."window_gte" < "incidents"."window_lt")
);
--> statement-breakpoint
CREATE INDEX "incidents_org_id_created_at_index" ON "incidents" USING btree ("org_id","created_at");