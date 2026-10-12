import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackendError, HttpTranscriptionBackend, type TranscriptionBackend } from '../src/ai/transcription/backend.js';
import { NoBackendError, TranscriptionPool } from '../src/ai/transcription/pool.js';

const log = pino({ level: 'silent' });
const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
const opts = { language: 'fr' };

function fake(name: string, behaviour: { healthy?: boolean; fail?: BackendError[]; text?: string }): TranscriptionBackend & { calls: number } {
  const failures = [...(behaviour.fail ?? [])];
  return {
    name,
    concurrency: 1,
    calls: 0,
    async health() {
      return behaviour.healthy ?? true;
    },
    async transcribe() {
      this.calls++;
      const f = failures.shift();
      if (f) throw f;
      return { segments: [{ start: 0, end: 1, text: behaviour.text ?? name }], model: `${name}-model` };
    },
  };
}
const noWait = { sleep: async () => undefined };

describe('TranscriptionPool (bascule)', () => {
  it('utilise le premier backend sain', async () => {
    const a = fake('a', {});
    const b = fake('b', {});
    const r = await new TranscriptionPool([a, b], log, noWait).transcribe(audio, 'x.wav', opts);
    expect([r.backend, a.calls, b.calls]).toEqual(['a', 1, 0]);
  });

  it('saute un backend en échec au health check', async () => {
    const r = await new TranscriptionPool([fake('a', { healthy: false }), fake('b', {})], log, noWait).transcribe(audio, 'x.wav', opts);
    expect(r.backend).toBe('b');
  });

  it('bascule sur erreur, occupation (429) ou délai', async () => {
    for (const kind of ['unavailable', 'busy', 'timeout'] as const) {
      const r = await new TranscriptionPool([fake('a', { fail: [new BackendError('x', kind)] }), fake('b', {})], log, noWait).transcribe(audio, 'x.wav', opts);
      expect(r.backend).toBe('b');
    }
  });

  it('nouveau tour après échec général, puis succès', async () => {
    const a = fake('a', { fail: [new BackendError('occupé', 'busy')] });
    const r = await new TranscriptionPool([a], log, noWait).transcribe(audio, 'x.wav', opts);
    expect([r.backend, a.calls]).toEqual(['a', 2]);
  });

  it('abandon après tous les tours, avec les causes', async () => {
    const a = fake('a', { fail: Array(5).fill(new BackendError('a : erreur 500', 'unavailable')) });
    await expect(new TranscriptionPool([a], log, { ...noWait, rounds: 2, healthTtlMs: 0 }).transcribe(audio, 'x.wav', opts)).rejects.toThrow(/2 tours.*a : erreur 500/);
  });

  it('un backend tombé est mis de côté le temps du cache de santé', async () => {
    let now = 0;
    const a = fake('a', { fail: [new BackendError('down', 'unavailable')] });
    const b = fake('b', {});
    const pool = new TranscriptionPool([a, b], log, { ...noWait, now: () => now, healthTtlMs: 30_000 });
    await pool.transcribe(audio, 'x.wav', opts);
    await pool.transcribe(audio, 'x.wav', opts);
    expect([a.calls, b.calls]).toEqual([1, 2]); // a non retenté pendant 30 s
    now = 31_000;
    await pool.transcribe(audio, 'x.wav', opts);
    expect(a.calls).toBe(2);
  });

  it('sans backend configuré : erreur explicite', async () => {
    await expect(new TranscriptionPool([], log).transcribe(audio, 'x.wav', opts)).rejects.toBeInstanceOf(NoBackendError);
  });
});

describe('HttpTranscriptionBackend (serveur simulé)', () => {
  let server: Server;
  let base: string;
  const received: Array<{ path: string; fields: Record<string, string>; file?: string; auth?: string }> = [];
  let mode: 'ok' | 'busy' | 'notready' | 'slow' = 'ok';

  async function readForm(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = await new Request('http://x', { method: 'POST', headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) }).formData();
    const fields: Record<string, string> = {};
    let file: string | undefined;
    for (const [k, v] of form) {
      if (typeof v === 'string') fields[k] = v;
      else file = v.name;
    }
    return { fields, file };
  }

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const path = req.url ?? '';
      if (path === '/ready') return res.writeHead(mode === 'notready' ? 503 : 200).end('{"status":"ready","model":"ggml-large-v3-turbo.bin"}');
      if (path === '/v1/models') return res.writeHead(200).end('{"data":[]}');
      if (path === '/v1/audio/transcriptions') {
        const { fields, file } = await readForm(req);
        received.push({ path, fields, ...(file ? { file } : {}), ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
        if (mode === 'busy') return res.writeHead(429).end('{"error":{"code":"busy"}}');
        if (mode === 'slow') return void setTimeout(() => res.writeHead(200).end('{}'), 3000);
        return res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ text: 'Bonjour.', segments: [{ start: 0.5, end: 1.8, text: ' Bonjour.', no_speech_prob: 0.01 }] }));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const vibe = () => new HttpTranscriptionBackend({ name: 'vibe', type: 'vibe', url: base, model: 'whisper-1', timeoutSec: 60, healthTimeoutSec: 2, concurrency: 4 });

  it('vibe : multipart verbose_json, segments horodatés, concurrence forcée à 1', async () => {
    mode = 'ok';
    const backend = vibe();
    expect(backend.concurrency).toBe(1);
    const r = await backend.transcribe(audio, 'bloc.wav', { language: 'fr', prompt: 'ODJ, CA' });
    expect(r.segments).toEqual([{ start: 0.5, end: 1.8, text: ' Bonjour.', noSpeechProb: 0.01 }]);
    const last = received.at(-1)!;
    expect(last.file).toBe('bloc.wav');
    expect(last.fields).toMatchObject({ language: 'fr', response_format: 'verbose_json', prompt: 'ODJ, CA' });
  });

  it('vibe : modèle chargé (annoncé par /ready) repris dans le résultat', async () => {
    mode = 'ok';
    const backend = vibe();
    await backend.health();
    expect((await backend.transcribe(audio, 'b.wav', opts)).model).toBe('ggml-large-v3-turbo.bin');
  });

  it('vibe : health sur /ready (503 sans modèle chargé)', async () => {
    mode = 'ok';
    expect(await vibe().health()).toBe(true);
    mode = 'notready';
    expect(await vibe().health()).toBe(false);
  });

  it('vibe : 429 → erreur « busy »', async () => {
    mode = 'busy';
    await expect(vibe().transcribe(audio, 'b.wav', opts)).rejects.toMatchObject({ kind: 'busy' });
  });

  it('openai : url /v1, modèle et clé transmis, health sur /models', async () => {
    mode = 'ok';
    const backend = new HttpTranscriptionBackend({
      name: 'speaches',
      type: 'openai',
      url: `${base}/v1/`,
      model: 'Systran/faster-whisper-large-v3',
      apiKey: 'secret',
      timeoutSec: 60,
      healthTimeoutSec: 2,
      concurrency: 2,
    });
    expect(await backend.health()).toBe(true);
    await backend.transcribe(audio, 'b.wav', opts);
    expect(received.at(-1)).toMatchObject({ fields: { model: 'Systran/faster-whisper-large-v3' }, auth: 'Bearer secret' });
  });

  it('délai dépassé → erreur « timeout »', async () => {
    mode = 'slow';
    const backend = new HttpTranscriptionBackend({ name: 'lent', type: 'vibe', url: base, model: 'w', timeoutSec: 1, healthTimeoutSec: 1, concurrency: 1 });
    await expect(backend.transcribe(audio, 'b.wav', opts)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('serveur injoignable → « unavailable »', async () => {
    const backend = new HttpTranscriptionBackend({ name: 'off', type: 'vibe', url: 'http://127.0.0.1:1', model: 'w', timeoutSec: 5, healthTimeoutSec: 1, concurrency: 1 });
    expect(await backend.health()).toBe(false);
    await expect(backend.transcribe(audio, 'b.wav', opts)).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
