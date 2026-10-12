CREATE TABLE "capture_stats" (
	"recording_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"received_packets" integer NOT NULL,
	"written_packets" integer NOT NULL,
	"stream_errors" integer NOT NULL,
	CONSTRAINT "capture_stats_recording_id_user_id_pk" PRIMARY KEY("recording_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "capture_stats" ADD CONSTRAINT "capture_stats_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;