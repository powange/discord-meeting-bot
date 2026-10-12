import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { maskKey, moveTo, testBackend } from '../src/services/transcriptionBackends.js';

describe('ordre de bascule', () => {
  it('déplace un serveur à la position voulue', () => {
    expect(moveTo(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveTo(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
    expect(moveTo(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
    expect(moveTo(['a'], 'z', 0)).toBeNull();
  });
  it('clé masquée', () => {
    expect([maskKey(null), maskKey('abc'), maskKey('sk-123456')]).toEqual(['—', '••••', '••••3456']);
  });
});

describe('testBackend (serveur simulé + ffmpeg réel)', () => {
  let server: Server;
  let base: string;
  let bytes = 0;
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      if (req.url === '/ready') return res.writeHead(200).end();
      let n = 0;
      for await (const c of req) n += (c as Buffer).length;
      bytes = n;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"model":"ggml-large-v3-turbo","segments":[]}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const config = buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {});
  const backend = (url: string) => ({ name: 'vibe-pc', type: 'vibe' as const, url, model: 'w', timeoutSec: 30, healthTimeoutSec: 2, concurrency: 1 });

  it('opérationnel : santé puis vraie transcription (WAV d’une seconde envoyé)', async () => {
    const r = await testBackend(backend(base), config, 'fr');
    expect(r).toMatchObject({ healthy: true, model: 'ggml-large-v3-turbo' });
    expect(r.error).toBeUndefined();
    expect(bytes).toBeGreaterThan(32_000); // 1 s de PCM 16 kHz mono
  });

  it('injoignable : échec au health check', async () => {
    expect(await testBackend(backend('http://127.0.0.1:1'), config, 'fr')).toMatchObject({ healthy: false });
  });
});
