import { z } from 'zod';
import { LlmClient } from '../ai/llm/client.js';
import { fetchWithTimeout, trimSlash } from '../ai/http.js';
import type { AppConfig, LlmConfig } from '../config/index.js';
import type { GuildSettingsRow } from '../db/schema.js';
import { assertUrlAllowed } from '../lib/hosts.js';
import { decryptSecret } from '../lib/secrets.js';

export interface EffectiveLlm {
  /** `discord` : réglé par /config ; `yaml` : fichier de configuration. */
  source: 'discord' | 'yaml';
  enabled: boolean;
  config: LlmConfig;
}

/** LLM des résumés d'un serveur : réglage Discord s'il existe, sinon YAML ; désactivable. */
export function effectiveLlm(settings: GuildSettingsRow, config: AppConfig): EffectiveLlm {
  const yaml = config.guild(settings.guildId).llm;
  // Le modèle se règle indépendamment de l'adresse : choisir un modèle ne recopie pas en base
  // l'adresse ni la clé du fichier de configuration.
  const model = settings.llmModel ?? yaml.model;
  if (settings.llmBaseUrl) {
    const { apiKey: _ignored, ...rest } = yaml;
    const apiKey = decryptSecret(settings.llmApiKey);
    return {
      source: 'discord',
      enabled: settings.llmEnabled,
      config: { ...rest, baseUrl: settings.llmBaseUrl, model, ...(apiKey ? { apiKey } : {}) },
    };
  }
  return { source: settings.llmModel ? 'discord' : 'yaml', enabled: settings.llmEnabled, config: { ...yaml, model } };
}

/** Modèles proposés par le serveur (GET /models), sans les modèles d'embedding. */
export async function listModels(llm: LlmConfig, allowedHosts: readonly string[]): Promise<string[]> {
  if (!llm.baseUrl) return [];
  await assertUrlAllowed(llm.baseUrl, allowedHosts);
  const res = await fetchWithTimeout(`${trimSlash(llm.baseUrl)}/models`, { headers: llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {} }, 5000);
  if (!res.ok) throw new Error(`liste des modèles indisponible (${res.status})`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  return (body.data ?? [])
    .map((m) => (typeof m.id === 'string' ? m.id : ''))
    .filter((id) => id && !/embed/i.test(id))
    .sort((a, b) => a.localeCompare(b));
}

export interface LlmTest {
  ok: boolean;
  ms?: number;
  model?: string;
  error?: string;
}

/** Essai réel : une réponse JSON courte, avec la latence. */
export async function testLlm(llm: LlmConfig, allowedHosts: readonly string[]): Promise<LlmTest> {
  if (!llm.baseUrl) return { ok: false, error: 'aucune adresse configurée' };
  const started = Date.now();
  try {
    const client = new LlmClient({ ...llm, timeoutSec: Math.min(llm.timeoutSec, 180) }, allowedHosts, { attempts: 1, delayMs: 0 });
    const r = await client.json([{ role: 'user', content: 'Réponds exactement {"ok": true}.' }], z.object({ ok: z.boolean() }));
    return { ok: true, ms: Date.now() - started, model: r.deployment ? `${r.model} (${r.deployment})` : r.model };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
