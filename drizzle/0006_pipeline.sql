CREATE TYPE "public"."pipeline_step" AS ENUM('transcribe', 'summarize', 'publish');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "pipeline_steps" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pipeline_steps_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"meeting_id" uuid NOT NULL,
	"step" "pipeline_step" NOT NULL,
	"status" "step_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"output" jsonb,
	CONSTRAINT "pipeline_steps_meetingId_step_unique" UNIQUE("meeting_id","step")
);
--> statement-breakpoint
CREATE TABLE "summaries" (
	"meeting_id" uuid PRIMARY KEY NOT NULL,
	"content" jsonb NOT NULL,
	"llm_model" text NOT NULL,
	"llm_deployments" text[] NOT NULL,
	"transcription_backends" text[] NOT NULL,
	"passes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transcript_segments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"meeting_id" uuid NOT NULL,
	"block_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcription_blocks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transcription_blocks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"meeting_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"segment_ids" integer[] NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"backend" text,
	"model" text,
	CONSTRAINT "transcription_blocks_recordingId_userId_startMs_unique" UNIQUE("recording_id","user_id","start_ms")
);
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "report_status_message_id" text;--> statement-breakpoint
ALTER TABLE "pipeline_steps" ADD CONSTRAINT "pipeline_steps_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_block_id_transcription_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."transcription_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_blocks" ADD CONSTRAINT "transcription_blocks_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_blocks" ADD CONSTRAINT "transcription_blocks_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_segments_meeting_id_start_at_index" ON "transcript_segments" USING btree ("meeting_id","start_at");--> statement-breakpoint
CREATE INDEX "transcription_blocks_meeting_id_index" ON "transcription_blocks" USING btree ("meeting_id");