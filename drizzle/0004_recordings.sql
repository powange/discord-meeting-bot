CREATE TYPE "public"."recording_status" AS ENUM('recording', 'stopped', 'interrupted', 'failed');--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'record_start';--> statement-breakpoint
CREATE TABLE "audio_segments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audio_segments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"recording_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"packets" integer NOT NULL,
	"file_path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recording_presence" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recording_presence_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"recording_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"excluded" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"guild_id" text NOT NULL,
	"voice_channel_id" text NOT NULL,
	"started_by" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"status" "recording_status" DEFAULT 'recording' NOT NULL,
	"stop_reason" text,
	"data_dir" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audio_segments" ADD CONSTRAINT "audio_segments_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_presence" ADD CONSTRAINT "recording_presence_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audio_segments_recording_id_user_id_start_ms_index" ON "audio_segments" USING btree ("recording_id","user_id","start_ms");--> statement-breakpoint
CREATE INDEX "recording_presence_recording_id_index" ON "recording_presence" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "recordings_meeting_id_index" ON "recordings" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "recordings_status_index" ON "recordings" USING btree ("status");