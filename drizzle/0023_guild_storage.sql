ALTER TYPE "public"."pipeline_step" ADD VALUE 'export';--> statement-breakpoint
CREATE TABLE "guild_storage" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"credentials" text NOT NULL,
	"account" text NOT NULL,
	"folder" text DEFAULT 'Meeting recorder' NOT NULL,
	"connected_by" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error" text
);
