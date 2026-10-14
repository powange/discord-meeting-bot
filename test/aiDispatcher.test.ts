import { describe, expect, it, vi } from 'vitest';

// Options passées à l'Agent undici des appels aux serveurs d'IA.
const created = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('undici', () => ({
  Agent: class {
    constructor(options: Record<string, unknown>) {
      created.push(options);
    }
  },
}));

describe('appels aux serveurs d’IA (LM Studio, Vibe…)', () => {
  it('aucun délai caché de 300 s : un résumé ou un bloc de transcription peut dépasser 5 min', async () => {
    const { guardedDispatcher } = await import('../src/ai/http.js');
    guardedDispatcher([]); // sans AI_ALLOWED_HOSTS
    guardedDispatcher(['192.168.0.0/24']);
    expect(created).toHaveLength(2);
    for (const options of created) expect(options).toMatchObject({ headersTimeout: 0, bodyTimeout: 0 });
    expect(created[1]!.connect).toBeDefined(); // adresses vérifiées à la connexion
    expect(created[0]!.connect).toBeUndefined();
  });
});
