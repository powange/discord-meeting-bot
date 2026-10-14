import { z } from 'zod';
import type { LlmConfig } from '../../config/index.js';
import { assertUrlAllowed, errorSnippet } from '../../lib/hosts.js';
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
  /** Erreur passagère (serveur occupé, 5xx, délai, injoignable) : une nouvelle tentative a du sens. */
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}

/** Tentatives par requête : une erreur passagère sur une passe ne doit pas faire échouer tout le résumé. */
const ATTEMPTS = 3;

/**
 * Format de réponse demandé au serveur, du plus strict au plus permissif. Les serveurs ne
 * supportent pas tous les mêmes : LM Studio exige `json_schema`, d'anciens serveurs ne
 * connaissent que `json_object`. On descend d'un cran quand le serveur refuse le format.
 */
const FORMATS = ['json_schema', 'json_object', 'none'] as const;
type ResponseFormat = (typeof FORMATS)[number];

/** Schéma JSON envoyé au modèle : tous les champs requis (le modèle les remplit), sans bornes inutiles. */
export function responseSchema(schema: z.ZodType): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === '$schema' || k === 'default' || k === 'minimum' || k === 'maximum') continue;
        out[k] = strip(v);
      }
      return out;
    }
    return node;
  };
  return strip(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' })) as Record<string, unknown>;
}

/**
 * Client chat/completions compatible OpenAI : LiteLLM (bascule et répartition entre machines)
 * ou Ollama / LM Studio en direct. Réponses en JSON, validées par un schéma zod.
 */
export class LlmClient {
  /** Format retenu pour ce serveur (mémorisé après un refus). */
  private format: ResponseFormat = 'json_schema';

  constructor(
    private readonly config: LlmConfig,
    private readonly allowedHosts: readonly string[] = [],
    /** Tentatives sur erreur passagère, et attente avant la 2e (doublée ensuite). Un test de connexion n'en fait qu'une. */
    private readonly retry: { attempts: number; delayMs: number } = { attempts: ATTEMPTS, delayMs: 2000 },
  ) {
    if (!config.baseUrl) throw new LlmError('Aucun serveur LLM configuré (llm.baseUrl).');
  }

  get model(): string {
    return this.config.model;
  }

  /** Demande une réponse JSON conforme à `schema` ; une seconde tentative corrige un JSON invalide. */
  async json<S extends z.ZodType>(messages: readonly ChatMessage[], schema: S, signal?: AbortSignal): Promise<JsonResult<z.infer<S>>> {
    const first = await this.chat(messages, schema, signal);
    const parsed = parseJson(first.content, schema);
    if (parsed.ok) return { value: parsed.value, model: first.model, deployment: first.deployment };

    const retry = await this.chat(
      [
        ...messages,
        { role: 'assistant', content: first.content },
        { role: 'user', content: `Ta réponse est invalide (${parsed.error}). Renvoie uniquement l'objet JSON corrigé, sans texte autour.` },
      ],
      schema,
      signal,
    );
    const again = parseJson(retry.content, schema);
    if (!again.ok) throw new LlmError(`Réponse du modèle invalide après correction : ${again.error}`);
    return { value: again.value, model: retry.model, deployment: retry.deployment ?? first.deployment };
  }

  private async chat(messages: readonly ChatMessage[], schema: z.ZodType, signal?: AbortSignal): Promise<{ content: string; model: string; deployment: string | null }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.chatOnce(messages, schema, signal);
      } catch (err) {
        if (!(err instanceof LlmError) || !err.transient || attempt >= this.retry.attempts || signal?.aborted) throw err;
        await new Promise((r) => setTimeout(r, this.retry.delayMs * 2 ** (attempt - 1)));
      }
    }
  }

  private async chatOnce(messages: readonly ChatMessage[], schema: z.ZodType, signal?: AbortSignal): Promise<{ content: string; model: string; deployment: string | null }> {
    for (;;) {
      const res = await this.post(messages, this.responseFormat(schema), signal);
      if (res.ok) {
        const body = (await res.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }> };
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new LlmError('LLM : réponse sans contenu');
        return { content, model: body.model ?? this.config.model, deployment: res.headers.get('x-litellm-model-id') };
      }
      const raw = await res.text().catch(() => '');
      // Format refusé (400/422 mentionnant response_format) : on essaie le suivant.
      const next = FORMATS[FORMATS.indexOf(this.format) + 1];
      if ((res.status === 400 || res.status === 422) && /response_format|json_schema|json_object/i.test(raw) && next) {
        this.format = next;
        continue;
      }
      throw new LlmError(`LLM : erreur ${res.status} ${errorSnippet(raw)}`.trim(), res.status === 429 || res.status >= 500);
    }
  }

  private responseFormat(schema: z.ZodType): Record<string, unknown> | undefined {
    if (this.format === 'json_schema') return { type: 'json_schema', json_schema: { name: 'reponse', strict: true, schema: responseSchema(schema) } };
    if (this.format === 'json_object') return { type: 'json_object' };
    return undefined; // la consigne JSON du prompt suffit, la réponse est validée de toute façon
  }

  private async post(messages: readonly ChatMessage[], responseFormat: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<Response> {
    await assertUrlAllowed(this.config.baseUrl!, this.allowedHosts).catch((err: Error) => {
      throw new LlmError(err.message);
    });
    try {
      return await fetchWithTimeout(
        `${trimSlash(this.config.baseUrl!)}/chat/completions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
          body: JSON.stringify({
            model: this.config.model,
            messages: this.config.thinking ? messages : withoutThinking(messages),
            temperature: this.config.temperature,
            ...(responseFormat ? { response_format: responseFormat } : {}),
          }),
        },
        this.config.timeoutSec * 1000,
        signal,
        this.allowedHosts,
      );
    } catch (err) {
      if (isTimeout(err) && !signal?.aborted) throw new LlmError(`LLM : délai dépassé (${this.config.timeoutSec} s)`, true);
      throw new LlmError(`LLM injoignable : ${err instanceof Error ? err.message : err}`, !signal?.aborted);
    }
  }
}

/**
 * Réflexion désactivée : « /no_think » à la fin des consignes système. Qwen3 répond alors
 * directement (bien plus vite) ; les modèles qui ne connaissent pas ce mot-clé l'ignorent.
 */
export function withoutThinking(messages: readonly ChatMessage[]): ChatMessage[] {
  const at = messages.findIndex((msg) => msg.role === 'system');
  if (at < 0) return [{ role: 'system', content: '/no_think' }, ...messages];
  return messages.map((msg, i) => (i === at ? { ...msg, content: `${msg.content}\n\n/no_think` } : msg));
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
