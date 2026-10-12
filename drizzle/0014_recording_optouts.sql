CREATE TABLE "recording_optouts" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_optouts_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
