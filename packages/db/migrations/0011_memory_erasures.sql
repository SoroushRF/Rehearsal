CREATE TABLE "memory_erasure_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"summary" jsonb NOT NULL,
	"operator" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_erasure_events_kind" CHECK ("memory_erasure_events"."kind" in ('erased', 'forgotten'))
);
--> statement-breakpoint
CREATE INDEX "memory_erasure_events_org_id_index" ON "memory_erasure_events" USING btree ("org_id");