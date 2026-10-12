import type { z } from 'zod';
import type { LlmConfig } from '../../config/index.js';
import { fetchWithTimeout, isTimeout, trimSlash } from '../http.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonResult<T> {
  value: T;
  /** Modèle annoncé dans la réponse. */
  model: string;
  /** Déploiement LiteLLM qui a répondu (en-tête x-litellm-model-id), si disponible. */
  deployment: string | null;
}

export class LlmError extends Error {
  override name = 'LlmError';
}

/**
 * Client chat/completions compatible OpenAI : LiteLLM (bascule et répartition entre machines)
 * ou Ollama / LM Studio en direct. Réponses en JSON, validées par un schéma zod.
 */
export class LlmClient {
  constructor(private readonly config: LlmConfig) {
    if (!config.baseUrl) throw new LlmError('Aucun serveur LLM configuré (llm.baseUrl).');
  }

  get model(): string {
    return this.config.model;
  }

  /** Demande une réponse JSON conforme à `schema` ; une seconde tentative corrige un JSON invalide. */
  async json<S extends z.ZodType>(messages: readonly ChatMessage[], schema: S, signal?: AbortSignal): Promise<JsonResult<z.infer<S>>> {
    const first = await this.chat(messages, signal);
    const parsed = parseJson(first.content, schema);
    if (parsed.ok) return { value: parsed.value, model: first.model, deployment: first.deployment };

    const retry = await this.chat(
      [
        ...messages,
        { role: 'assistant', content: first.content },
        { role: 'user', content: `Ta réponse est invalide (${parsed.error}). Renvoie uniquement l'objet JSON corrigé, sans texte autour.` },
      ],
      signal,
    );
    const again = parseJson(retry.content, schema);
    if (!again.ok) throw new LlmError(`Réponse du modèle invalide après correction : ${again.error}`);
    return { value: again.value, model: retry.model, deployment: retry.deployment ?? first.deployment };
  }

  private async chat(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<{ content: string; model: string; deployment: string | null }> {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${trimSlash(this.config.baseUrl!)}/chat/completions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
          body: JSON.stringify({
            model: this.config.model,
            messages,
            temperature: this.config.temperature,
            response_format: { type: 'json_object' },
          }),
        },
        this.config.timeoutSec * 1000,
        signal,
      );
    } catch (err) {
      if (isTimeout(err) && !signal?.aborted) throw new LlmError(`LLM : délai dépassé (${this.config.timeoutSec} s)`);
      throw new LlmError(`LLM injoignable : ${err instanceof Error ? err.message : err}`);
    }
    if (!res.ok) throw new LlmError(`LLM : erreur ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const body = (await res.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new LlmError('LLM : réponse sans contenu');
    return { content, model: body.model ?? this.config.model, deployment: res.headers.get('x-litellm-model-id') };
  }
}

/** Extrait l'objet JSON d'une réponse (blocs ```json, raisonnement <think> des modèles type qwen3). */
export function extractJson(content: string): string {
  const withoutThink = content.replace(/<think>[\s\S]*?<\/think>/g, '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(withoutThink);
  const text = (fenced?.[1] ?? withoutThink).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function parseJson<S extends z.ZodType>(content: string, schema: S): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(content));
  } catch (err) {
    return { ok: false, error: `JSON illisible : ${err instanceof Error ? err.message : err}` };
  }
  const result = schema.safeParse(raw);
  if (!result.success) return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' ; ').slice(0, 500) };
  return { ok: true, value: result.data };
}
