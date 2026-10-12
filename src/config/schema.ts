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

const backendSchema = z.strictObject({
  /** Nom affiché dans les logs et la trace du compte rendu. */
  name: z.string().min(1),
  type: z.enum(['vibe', 'openai']),
  /** URL de base : http://hôte:port pour vibe, http://hôte:port/v1 pour un serveur compatible OpenAI. */
  url: z.url(),
  /** Modèle demandé (openai) ; ignoré par vibe, qui utilise le modèle chargé. */
  model: z.string().default('whisper-1'),
  apiKey: z.string().optional(),
  timeoutSec: z.int().min(10).max(3600).default(600),
  healthTimeoutSec: z.int().min(1).max(30).default(3),
  /** Requêtes simultanées vers ce serveur (vibe n'en traite qu'une). */
  concurrency: z.int().min(1).max(8).default(1),
});

const transcriptionSchema = z.strictObject({
  language: z.string().min(2).max(5).default('fr'),
  /** Vocabulaire propre au groupe (noms, sigles) : améliore la reconnaissance. */
  prompt: z.string().max(800).optional(),
  /** Backends par ordre de priorité ; bascule au suivant en cas d'erreur ou de délai dépassé. */
  backends: z.array(backendSchema).default([]),
  /** Prises de parole d'une même personne séparées de moins de N s : transcrites ensemble. */
  maxGapSec: z.int().min(0).max(60).default(4),
  /** Durée maximale d'un bloc envoyé à la transcription. */
  maxBlockMin: z.int().min(1).max(30).default(5),
});

const llmSchema = z.strictObject({
  /** Serveur compatible OpenAI : LiteLLM (recommandé, bascule entre machines) ou Ollama directement. */
  baseUrl: z.url().optional(),
  apiKey: z.string().optional(),
  /** Nom du modèle (model_name LiteLLM, ou nom Ollama). */
  model: z.string().default('summary'),
  /** Taille des morceaux de transcription par passe de résumé (tokens estimés). */
  chunkTokens: z.int().min(1000).max(100_000).default(6000),
  temperature: z.number().min(0).max(2).default(0.2),
  timeoutSec: z.int().min(10).max(3600).default(600),
});

/** Bloc configurable par serveur (`defaults` puis surcharge `guilds.<id>`). Les phases suivantes y ajouteront transcription, llm, storage… */
export const guildBlockSchema = z.strictObject({
  seed: guildSeedSchema.prefault({}),
  recording: recordingSchema.prefault({}),
  transcription: transcriptionSchema.prefault({}),
  llm: llmSchema.prefault({}),
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
  /** Binaire ffmpeg (préparation de l'audio). Vide : ffmpeg-static en développement, sinon `ffmpeg` du PATH. */
  ffmpegPath: z.string().optional(),
  scheduler: z.strictObject({ tickSeconds: z.int().min(5).max(300).default(30) }).prefault({}),
  defaults: z.unknown().optional(),
  guilds: z.record(snowflake, z.unknown()).default({}),
});

export type GuildBlock = z.infer<typeof guildBlockSchema>;
export type GuildSeed = GuildBlock['seed'];
export type RecordingConfig = GuildBlock['recording'];
export type TranscriptionConfig = GuildBlock['transcription'];
export type BackendConfig = TranscriptionConfig['backends'][number];
export type LlmConfig = GuildBlock['llm'];
