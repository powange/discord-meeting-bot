ALTER TYPE "public"."job_kind" ADD VALUE 'voice_create';--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "voice_channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "auto_voice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "auto_voice_category_id" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "auto_voice_lead_min" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "voice_temporary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "voice_deleted_at" timestamp with time zone;