import type { Logger } from '../../lib/logger.js';
import { BackendError, type TranscribeOptions, type TranscriptionBackend, type TranscriptionResult } from './backend.js';

export interface PoolOptions {
  /** Durée de validité d'un résultat de health check. */
  healthTtlMs?: number;
  /** Tours complets de la liste avant d'abandonner. */
  rounds?: number;
  /** Attente entre deux tours (multipliée par le numéro du tour). */
  roundDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class NoBackendError extends Error {
  override name = 'NoBackendError';
}

/**
 * Bascule entre backends de transcription, par ordre de priorité : health check court (mis en
 * cache), puis requête ; en cas d'erreur, de délai dépassé ou de serveur occupé, on passe au
 * suivant. Après un tour complet sans succès, on attend puis on recommence.
 */
export class TranscriptionPool {
  private readonly health = new Map<string, { ok: boolean; at: number }>();
  private readonly inFlight = new Map<string, number>();
  private readonly opts: Required<PoolOptions>;

  constructor(
    private readonly backends: readonly TranscriptionBackend[],
    private readonly log: Logger,
    options: PoolOptions = {},
  ) {
    this.opts = {
      healthTtlMs: 30_000,
      rounds: 3,
      roundDelayMs: 15_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      ...options,
    };
  }

  /** Nombre de transcriptions pouvant tourner en parallèle (somme des capacités). */
  get capacity(): number {
    return this.backends.reduce((n, b) => n + b.concurrency, 0);
  }

  async transcribe(audio: Blob, filename: string, options: TranscribeOptions, signal?: AbortSignal): Promise<TranscriptionResult & { backend: string }> {
    if (this.backends.length === 0) throw new NoBackendError('Aucun backend de transcription configuré (transcription.backends).');
    const errors: string[] = [];

    for (let round = 0; round < this.opts.rounds; round++) {
      let allFull = true;
      for (const backend of this.backends) {
        signal?.throwIfAborted();
        if ((this.inFlight.get(backend.name) ?? 0) >= backend.concurrency) continue;
        allFull = false;
        if (!(await this.isHealthy(backend, signal))) {
          errors.push(`${backend.name} : indisponible`);
          continue;
        }
        this.inFlight.set(backend.name, (this.inFlight.get(backend.name) ?? 0) + 1);
        try {
          const result = await backend.transcribe(audio, filename, options, signal);
          return { ...result, backend: backend.name };
        } catch (err) {
          if (signal?.aborted) throw err;
          const kind = err instanceof BackendError ? err.kind : 'unavailable';
          errors.push(err instanceof Error ? err.message : String(err));
          this.log.warn({ backend: backend.name, kind, err: err instanceof Error ? err.message : err }, 'Transcription : bascule au backend suivant');
          if (kind === 'unavailable' || kind === 'timeout') this.health.set(backend.name, { ok: false, at: this.opts.now() });
        } finally {
          this.inFlight.set(backend.name, (this.inFlight.get(backend.name) ?? 1) - 1);
        }
      }
      if (allFull) {
        // Tous les backends sont occupés par nos propres requêtes : on attend une place sans compter de tour.
        round--;
        await this.opts.sleep(250);
        continue;
      }
      if (round < this.opts.rounds - 1) await this.opts.sleep(this.opts.roundDelayMs * (round + 1));
    }
    throw new Error(`Transcription impossible après ${this.opts.rounds} tours : ${[...new Set(errors)].join(' ; ')}`);
  }

  private async isHealthy(backend: TranscriptionBackend, signal?: AbortSignal): Promise<boolean> {
    const cached = this.health.get(backend.name);
    if (cached && this.opts.now() - cached.at < this.opts.healthTtlMs) return cached.ok;
    const ok = await backend.health(signal);
    this.health.set(backend.name, { ok, at: this.opts.now() });
    return ok;
  }
}
