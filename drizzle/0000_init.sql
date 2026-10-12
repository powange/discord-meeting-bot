CREATE TYPE "public"."job_kind" AS ENUM('reminder', 'start', 'auto_end');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('scheduled', 'live', 'ended', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."rsvp_status" AS ENUM('yes', 'maybe', 'no');--> statement-breakpoint
CREATE TABLE "agenda_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agenda_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"meeting_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"author_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"forum_channel_id" text,
	"tag_ids" jsonb,
	"manager_role_id" text,
	"optout_role_id" text,
	"nudge_role_id" text,
	"creators_restricted" boolean DEFAULT false NOT NULL,
	"timezone" text NOT NULL,
	"locale" text NOT NULL,
	"reminder_offsets_min" integer[] NOT NULL,
	"default_duration_min" integer NOT NULL,
	"auto_record_default" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"thread_id" text,
	"scheduled_event_id" text,
	"voice_channel_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_min" integer NOT NULL,
	"organizer_id" text NOT NULL,
	"status" "meeting_status" DEFAULT 'scheduled' NOT NULL,
	"auto_record" boolean DEFAULT false NOT NULL,
	"agenda_locked" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_threadId_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
CREATE TABLE "rsvps" (
	"meeting_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" "rsvp_status" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rsvps_meeting_id_user_id_pk" PRIMARY KEY("meeting_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scheduled_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"meeting_id" uuid NOT NULL,
	"kind" "job_kind" NOT NULL,
	"offset_min" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"done_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "scheduled_jobs_meetingId_kind_offsetMin_unique" UNIQUE("meeting_id","kind","offset_min")
);
--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agenda_items_meeting_id_position_index" ON "agenda_items" USING btree ("meeting_id","position");--> statement-breakpoint
CREATE INDEX "meetings_guild_id_starts_at_index" ON "meetings" USING btree ("guild_id","starts_at");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_pending_idx" ON "scheduled_jobs" USING btree ("due_at") WHERE "scheduled_jobs"."done_at" is null;