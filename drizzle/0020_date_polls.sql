ALTER TYPE "public"."job_kind" ADD VALUE 'poll_nudge';--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'poll_close';--> statement-breakpoint
ALTER TYPE "public"."meeting_status" ADD VALUE 'polling';--> statement-breakpoint
CREATE TABLE "date_slots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "date_slots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"meeting_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_min" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "date_votes" (
	"slot_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"answer" "rsvp_status" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "date_votes_slot_id_user_id_pk" PRIMARY KEY("slot_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "poll_closes_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "date_slots" ADD CONSTRAINT "date_slots_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_votes" ADD CONSTRAINT "date_votes_slot_id_date_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."date_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "date_slots_meeting_id_starts_at_index" ON "date_slots" USING btree ("meeting_id","starts_at");