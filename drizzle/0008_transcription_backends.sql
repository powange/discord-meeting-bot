CREATE TABLE "transcription_backends" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transcription_backends_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"guild_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"url" text NOT NULL,
	"model" text DEFAULT 'whisper-1' NOT NULL,
	"api_key" text,
	"timeout_sec" integer DEFAULT 600 NOT NULL,
	"concurrency" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcription_backends_guildId_name_unique" UNIQUE("guild_id","name")
);
--> statement-breakpoint
CREATE INDEX "transcription_backends_guild_id_position_index" ON "transcription_backends" USING btree ("guild_id","position");