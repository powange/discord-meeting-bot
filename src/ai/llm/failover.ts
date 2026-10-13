import type { z } from 'zod';
import type { Logger } from '../../lib/logger.js';
import { LlmError, type ChatMessage, type JsonResult, type LlmClient } from './client.js';

/** Ce dont le résumé a besoin : une réponse JSON validée. */
export interface JsonLlm {
  json<S extends z.ZodType>(messages: readonly ChatMessage[], schema: S, signal?: AbortSignal): Promise<JsonResult<z.infer<S>>>;
}

/**
 * Serveurs de résumé par ordre de priorité, comme pour la transcription : si l'un échoue
 * (injoignable, occupé, erreur, modèle absent, réponse illisible), le suivant prend le relais
 * pour la même passe. Le dernier serveur qui a répondu est essayé en premier aux passes
 * suivantes, pour ne pas reperdre du temps sur un serveur en panne.
 */
export class FailoverLlm implements JsonLlm {
  private preferred = 0;

  constructor(
    private readonly servers: ReadonlyArray<{ name: string; client: LlmClient }>,
    private readonly log: Logger,
  ) {
    if (servers.length === 0) throw new LlmError('Aucun serveur de résumé actif.');
  }

  /** Modèle du serveur prioritaire (trace du compte rendu). */
  get model(): string {
    return this.servers[this.preferred]!.client.model;
  }

  async json<S extends z.ZodType>(messages: readonly ChatMessage[], schema: S, signal?: AbortSignal): Promise<JsonResult<z.infer<S>>> {
    const order = [...this.servers.keys()].map((i) => (this.preferred + i) % this.servers.length);
    const errors: string[] = [];
    for (const index of order) {
      signal?.throwIfAborted();
      const server = this.servers[index]!;
      try {
        const result = await server.client.json(messages, schema, signal);
        if (index !== this.preferred) this.log.info({ server: server.name }, 'Résumé : bascule sur un serveur de secours');
        this.preferred = index;
        // La trace du compte rendu nomme le serveur qui a répondu (sauf déploiement LiteLLM explicite).
        return { ...result, deployment: result.deployment ?? server.name };
      } catch (err) {
        if (signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn({ server: server.name, err: message }, 'Résumé : serveur en échec, essai du suivant');
        errors.push(`${server.name} : ${message}`);
      }
    }
    throw new LlmError(errors.length === 1 ? errors[0]! : `Tous les serveurs de résumé ont échoué (${errors.join(' · ')})`);
  }
}
