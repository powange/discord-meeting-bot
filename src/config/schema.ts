import { IANAZone } from 'luxon';
import { z } from 'zod';
import { LOCALES } from '../i18n/index.js';

export const snowflake = z.string().regex(/^\d{17,20}$/, 'identifiant Discord invalide');

/**
 * Valeurs initiales des réglages Discord d'un serveur. Elles ne servent qu'à créer la ligne
 * `guild_settings` la première fois ; ensuite c'est la BDD (commande /config) qui fait foi.
 */
const guildSeedSchema = z.strictObject({
  timezone: z.string().refine((tz) => IANAZone.isValidZone(tz), 'fuseau IANA invalide').default('Europe/Paris'),
  locale: z.enum(LOCALES).default('fr'),
  reminderOffsetsMin: z.array(z.int().positive().max(60 * 24 * 14)).max(5).default([1440, 15]),
  defaultDurationMin: z.int().min(5).max(24 * 60).default(60),
  autoRecordDefault: z.boolean().default(false),
});

/** Paramètres techniques de l'enregistrement (phase 2). */
const recordingSchema = z.strictObject({
  /** Le bot rejoint le vocal N minutes avant l'heure (démarrage auto) : avant l'arrivée des participants. */
  autoJoinLeadMin: z.int().min(0).max(30).default(2),
  /** Vocal vide depuis N minutes : clôture de la réunion (et donc de l'enregistrement). Jamais sur l'heure de fin. */
  endWhenEmptyMin: z.int().min(1).max(120).default(5),
  /** Silence qui clôt une prise de parole (un fichier par prise de parole). */
  silenceMs: z.int().min(200).max(10_000).default(1500),
  /** Échecs de déchiffrement DAVE consécutifs tolérés avant réinitialisation de la session chiffrée. */
  decryptionFailureTolerance: z.int().min(1).max(1000).default(48),
});

/** Bloc configurable par serveur (`defaults` puis surcharge `guilds.<id>`). Les phases suivantes y ajouteront transcription, llm, storage… */
export const guildBlockSchema = z.strictObject({
  seed: guildSeedSchema.prefault({}),
  recording: recordingSchema.prefault({}),
});

export const rootSchema = z.strictObject({
  discord: z.strictObject({
    token: z.string().min(1, 'DISCORD_TOKEN manquant'),
    /** Si non vide, les commandes sont enregistrées sur ces serveurs (instantané) plutôt qu'en global. */
    commandGuildIds: z.array(snowflake).default([]),
  }),
  database: z.strictObject({
    url: z.string().regex(/^postgres(ql)?:\/\//, 'URL PostgreSQL attendue (postgres://…)'),
  }),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** Données locales (pistes audio…). Monté en volume dans Docker. */
  dataDir: z.string().min(1).default('data'),
  scheduler: z.strictObject({ tickSeconds: z.int().min(5).max(300).default(30) }).prefault({}),
  defaults: z.unknown().optional(),
  guilds: z.record(snowflake, z.unknown()).default({}),
});

export type GuildBlock = z.infer<typeof guildBlockSchema>;
export type GuildSeed = GuildBlock['seed'];
export type RecordingConfig = GuildBlock['recording'];
