ALTER TABLE "guild_settings" ADD COLUMN "llm_base_url" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "llm_model" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "llm_api_key" text;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "llm_enabled" boolean DEFAULT true NOT NULL;