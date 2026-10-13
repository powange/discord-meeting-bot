import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpTranscriptionBackend } from '../ai/transcription/backend.js';
import type { AppConfig, BackendConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import type { TranscriptionBackendRow } from '../db/schema.js';
import { ffmpegPath, runFfmpeg } from '../lib/ffmpeg.js';
import { assertUrlAllowed } from '../lib/hosts.js';
import { decryptSecret } from '../lib/secrets.js';

export interface EffectiveBackends {
  /** `discord` : liste gérée par /config transcription ; `yaml` : valeur par défaut du fichier. */
  source: 'discord' | 'yaml';
  backends: BackendConfig[];
}

export function rowToConfig(row: TranscriptionBackendRow): BackendConfig {
  const apiKey = decryptSecret(row.apiKey);
  return {
    name: row.name,
    type: row.type,
    url: row.url,
    model: row.model,
    ...(apiKey ? { apiKey } : {}),
    timeoutSec: row.timeoutSec,
    healthTimeoutSec: 3,
    concurrency: row.concurrency,
  };
}

/**
 * Serveurs de transcription d'un serveur Discord : ceux ajoutés par /config transcription
 * (actifs, par priorité) dès qu'il y en a au moins un ; sinon ceux du YAML.
 */
export async function effectiveBackends(repos: Repositories, config: AppConfig, guildId: string): Promise<EffectiveBackends> {
  const rows = await repos.listBackends(guildId);
  if (rows.length > 0) return { source: 'discord', backends: rows.filter((r) => r.enabled).map(rowToConfig) };
  return { source: 'yaml', backends: config.guild(guildId).transcription.backends };
}

export interface BackendTest {
  healthy: boolean;
  /** Durée d'une transcription réelle (1 s de silence), si elle a abouti. */
  transcribeMs?: number;
  model?: string;
  error?: string;
}

/** Essai de bout en bout : health check, puis transcription d'une seconde de silence. */
export async function testBackend(backend: BackendConfig, config: AppConfig, language: string): Promise<BackendTest> {
  const client = new HttpTranscriptionBackend({ ...backend, timeoutSec: Math.min(backend.timeoutSec, 120) }, config.ai.allowedHosts);
  try {
    await assertUrlAllowed(backend.url, config.ai.allowedHosts);
  } catch (err) {
    return { healthy: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!(await client.health())) return { healthy: false, error: 'health check en échec (serveur injoignable ou modèle non chargé)' };
  const dir = await mkdtemp(join(tmpdir(), 'mb-test-'));
  try {
    const wav = join(dir, 'silence.wav');
    await runFfmpeg(ffmpegPath(config.ffmpegPath), ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', '-c:a', 'pcm_s16le', wav]);
    const started = Date.now();
    const result = await client.transcribe(new Blob([await readFile(wav)], { type: 'audio/wav' }), 'test.wav', { language });
    return { healthy: true, transcribeMs: Date.now() - started, model: result.model };
  } catch (err) {
    return { healthy: true, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Nouvel ordre après déplacement de `name` en position `index` (0 = priorité maximale). */
export function moveTo(names: readonly string[], name: string, index: number): string[] | null {
  if (!names.includes(name)) return null;
  const rest = names.filter((n) => n !== name);
  const at = Math.max(0, Math.min(rest.length, index));
  return [...rest.slice(0, at), name, ...rest.slice(at)];
}

export function maskKey(key: string | null): string {
  if (!key) return '—';
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}
