CREATE TABLE "rehearsal_dirty_marks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"container_set" text NOT NULL,
	"org_id" text NOT NULL,
	"rehearsal_id" text NOT NULL,
	"marked_at" timestamp with time zone NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" text
);
--> statement-breakpoint
CREATE INDEX "rehearsal_dirty_marks_container_set_index" ON "rehearsal_dirty_marks" USING btree ("container_set");--> statement-breakpoint
CREATE UNIQUE INDEX "rehearsal_dirty_marks_rehearsal_id_index" ON "rehearsal_dirty_marks" USING btree ("rehearsal_id");