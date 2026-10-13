import { z } from 'zod';
import { LlmClient } from '../ai/llm/client.js';
import { fetchWithTimeout, trimSlash } from '../ai/http.js';
import type { AppConfig, LlmConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import type { GuildSettingsRow, LlmBackendRow } from '../db/schema.js';
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

export interface LlmServer {
  /** Nom affiché (« principal », « pc-salon »…) ; « yaml » pour le fichier de configuration. */
  name: string;
  config: LlmConfig;
}

export interface EffectiveLlms {
  /** `discord` : liste gérée par /config → Résumé ; `yaml` : fichier de configuration. */
  source: 'discord' | 'yaml';
  enabled: boolean;
  /** Serveurs actifs, par ordre de priorité (le suivant prend le relais en cas d'échec). */
  servers: LlmServer[];
}

export function llmRowToConfig(row: LlmBackendRow, base: LlmConfig): LlmConfig {
  const { apiKey: _ignored, ...rest } = base;
  const apiKey = decryptSecret(row.apiKey);
  return { ...rest, baseUrl: row.url, model: row.model, ...(apiKey ? { apiKey } : {}) };
}

/**
 * Serveurs de résumé d'un serveur Discord : ceux de /config → Résumé (actifs, par priorité) dès
 * qu'il y en a au moins un ; sinon celui du YAML. Les réglages fins (taille des morceaux,
 * température, délai) viennent toujours du YAML.
 */
export async function effectiveLlms(repos: Repositories, settings: GuildSettingsRow, config: AppConfig): Promise<EffectiveLlms> {
  const yaml = config.guild(settings.guildId).llm;
  const rows = await repos.listLlmBackends(settings.guildId);
  if (rows.length > 0) {
    return { source: 'discord', enabled: settings.llmEnabled, servers: rows.filter((r) => r.enabled).map((r) => ({ name: r.name, config: llmRowToConfig(r, yaml) })) };
  }
  const single = effectiveLlm(settings, config).config;
  return { source: 'yaml', enabled: settings.llmEnabled, servers: single.baseUrl ? [{ name: 'yaml', config: single }] : [] };
}

/** Modèles proposés par le serveur (GET /models), sans les modèles d'embedding. */
export async function listModels(llm: LlmConfig, allowedHosts: readonly string[]): Promise<string[]> {
  if (!llm.baseUrl) return [];
  await assertUrlAllowed(llm.baseUrl, allowedHosts);
  const res = await fetchWithTimeout(`${trimSlash(llm.baseUrl)}/models`, { headers: llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {} }, 5000, undefined, allowedHosts);
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
