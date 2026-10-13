import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient } from '../src/ai/llm/client.js';
import { FailoverLlm } from '../src/ai/llm/failover.js';

/** Serveurs simulés : « ok » répond, « panne » renvoie 500, « absent » n'écoute pas. */
const hits = { ok: 0, panne: 0 };
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    for await (const _ of req);
    if (req.url?.startsWith('/panne')) {
      hits.panne++;
      return res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"crash"}');
    }
    hits.ok++;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'qwen3', choices: [{ message: { content: '{"ok":true}' } }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const client = (path: string) => new LlmClient({ baseUrl: `${base}/${path}/v1`, model: 'summary', chunkTokens: 6000, temperature: 0.2, timeoutSec: 5 }, [], { attempts: 1, delayMs: 0 });
const log = pino({ level: 'silent' });
const ask = (llm: FailoverLlm) => llm.json([{ role: 'user', content: 'x' }], z.object({ ok: z.boolean() }));

describe('serveurs de résumé de secours', () => {
  it('le premier en panne : le suivant répond, et la trace nomme le serveur qui a répondu', async () => {
    const llm = new FailoverLlm([{ name: 'principal', client: client('panne') }, { name: 'secours', client: client('ok') }], log);
    const r = await ask(llm);
    expect(r).toMatchObject({ value: { ok: true }, model: 'qwen3', deployment: 'secours' });
  });

  it('les passes suivantes commencent par le serveur qui a répondu (pas de temps perdu sur la panne)', async () => {
    const llm = new FailoverLlm([{ name: 'principal', client: client('panne') }, { name: 'secours', client: client('ok') }], log);
    await ask(llm);
    const before = hits.panne;
    await ask(llm);
    await ask(llm);
    expect(hits.panne).toBe(before);
  });

  it('tous en panne : erreur qui liste chaque serveur', async () => {
    const llm = new FailoverLlm(
      [
        { name: 'principal', client: client('panne') },
        { name: 'absent', client: new LlmClient({ baseUrl: 'http://127.0.0.1:1/v1', model: 's', chunkTokens: 6000, temperature: 0.2, timeoutSec: 2 }, [], { attempts: 1, delayMs: 0 }) },
      ],
      log,
    );
    await expect(ask(llm)).rejects.toThrow(/Tous les serveurs de résumé ont échoué \(principal : .*500.* · absent : /);
  });

  it('aucun serveur actif : refusé dès la construction', () => {
    expect(() => new FailoverLlm([], log)).toThrow('Aucun serveur de résumé actif');
  });
});
