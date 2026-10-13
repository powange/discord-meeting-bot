import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { deepMerge, interpolateEnv } from './env.js';
import { guildBlockSchema, rootSchema, type GuildBlock } from './schema.js';

export type { BackendConfig, GuildBlock, GuildSeed, LlmConfig, RecordingConfig, TranscriptionConfig } from './schema.js';

export interface AppConfig {
  discord: { token: string; commandGuildIds: string[] };
  database: { url: string };
  logLevel: string;
  dataDir: string;
  ffmpegPath: string | undefined;
  owners: string[];
  diskMinFreeGb: number;
  ai: { allowedHosts: string[] };
  scheduler: { tickSeconds: number };
  /** Config effective d'un serveur : `defaults` fusionné avec `guilds.<id>`. */
  guild(guildId: string): GuildBlock;
}

/** Config utilisée quand aucun fichier n'est fourni : tout vient des variables d'environnement. */
const FALLBACK = {
  discord: { token: '${DISCORD_TOKEN}' },
  database: { url: '${DATABASE_URL}' },
  logLevel: '${LOG_LEVEL:-info}',
  dataDir: '${DATA_DIR:-data}',
  ffmpegPath: '${FFMPEG_PATH:-}',
  ai: { allowedHosts: '${AI_ALLOWED_HOSTS:-}' },
  defaults: {
    llm: { baseUrl: '${LLM_BASE_URL:-}', apiKey: '${LLM_API_KEY:-}', model: '${LLM_MODEL:-summary}' },
  },
};

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(path = process.env.CONFIG_PATH ?? 'config/config.yaml', env = process.env): AppConfig {
  let raw: unknown = FALLBACK;
  if (existsSync(path)) raw = parseYaml(readFileSync(path, 'utf8')) ?? {};
  else if (process.env.CONFIG_PATH) throw new ConfigError(`Fichier de configuration introuvable : ${path}`);
  return buildConfig(raw, env);
}

export function buildConfig(raw: unknown, env: NodeJS.ProcessEnv): AppConfig {
  const missing = new Set<string>();
  const interpolated = interpolateEnv(raw, env, missing);
  if (missing.size > 0) {
    throw new ConfigError(`Variables d'environnement manquantes : ${[...missing].join(', ')}`);
  }

  const root = parseOrThrow(rootSchema, interpolated, 'config');
  const defaults = parseOrThrow(guildBlockSchema, root.defaults ?? {}, 'defaults');
  const perGuild = new Map<string, GuildBlock>();
  for (const [id, override] of Object.entries(root.guilds)) {
    perGuild.set(id, parseOrThrow(guildBlockSchema, deepMerge(root.defaults ?? {}, override), `guilds.${id}`));
  }

  return {
    discord: root.discord,
    database: root.database,
    logLevel: root.logLevel,
    dataDir: root.dataDir,
    ffmpegPath: root.ffmpegPath || undefined,
    owners: root.owners,
    diskMinFreeGb: root.diskMinFreeGb,
    ai: root.ai,
    scheduler: root.scheduler,
    guild: (guildId) => perGuild.get(guildId) ?? defaults,
  };
}

function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown, label: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ConfigError(`Configuration invalide (${label}) :\n${z.prettifyError(result.error)}`);
  return result.data;
}
