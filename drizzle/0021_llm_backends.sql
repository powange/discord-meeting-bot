CREATE TABLE "llm_backends" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "llm_backends_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"guild_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"model" text NOT NULL,
	"api_key" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_backends_guildId_name_unique" UNIQUE("guild_id","name")
);
--> statement-breakpoint
CREATE INDEX "llm_backends_guild_id_position_index" ON "llm_backends" USING btree ("guild_id","position");--> statement-breakpoint
-- Serveur de résumé déjà réglé dans /config : il devient le premier de la liste.
INSERT INTO "llm_backends" ("guild_id", "position", "name", "url", "model", "api_key") SELECT "guild_id", 0, 'principal', "llm_base_url", COALESCE("llm_model", 'summary'), "llm_api_key" FROM "guild_settings" WHERE "llm_base_url" IS NOT NULL;