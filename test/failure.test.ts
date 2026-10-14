import { describe, expect, it } from 'vitest';
import { failureCause } from '../src/domain/failure.js';

describe('cause publique d’un échec', () => {
  it.each([
    ['LLM injoignable : fetch failed', 'unreachable'],
    ['connect ECONNREFUSED 192.168.0.11:8080', 'unreachable'],
    ['LLM : délai dépassé (600 s)', 'timeout'],
    ['LLM : erreur 401 {"error":"invalid api key"}', 'auth'],
    ['LLM : erreur 404 model "qwen3" not found', 'model'],
    ['Vibe occupé (429)', 'busy'],
    ['ENOSPC: no space left on device', 'disk'],
    ['Transcription interrompue : elle dépassait la durée maximale (240 min).', 'tooLong'],
    ['Missing Permissions', 'discord'],
    ['Transcription impossible après 3 tours : vibe-pc : indisponible', 'unreachable'],
    ['This operation was aborted', 'timeout'],
    ['Opération annulée', 'timeout'],
    ['Tous les serveurs de résumé ont échoué (principal : LLM : erreur 400 Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (9908 tokens) exceeds the available context size (8192 tokens)"}})', 'context'],
    ["This model's maximum context length is 8192 tokens", 'context'],
    ['Cannot read properties of undefined', 'unknown'],
  ])('%s → %s', (error, cause) => {
    expect(failureCause(error)).toBe(cause);
  });
});
