import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchWithTimeout, guardedLookup } from '../src/ai/http.js';

let server: Server;
let port: number;
beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('appels sortants : adresse vérifiée à la connexion', () => {
  it('nom résolu vers une adresse non autorisée : connexion refusée', async () => {
    await expect(fetchWithTimeout(`http://localhost:${port}/`, {}, 5000, undefined, ['10.0.0.0/8'])).rejects.toThrow();
  });

  it('adresse autorisée par plage IP, ou nom autorisé explicitement : connexion acceptée', async () => {
    expect(await (await fetchWithTimeout(`http://localhost:${port}/`, {}, 5000, undefined, ['127.0.0.0/8'])).text()).toBe('ok');
    expect(await (await fetchWithTimeout(`http://localhost:${port}/`, {}, 5000, undefined, ['localhost'])).text()).toBe('ok');
    expect(await (await fetchWithTimeout(`http://localhost:${port}/`, {}, 5000)).text()).toBe('ok'); // aucune restriction
  });

  it('envoi de fichier (transcription) à travers la vérification', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'bloc.wav');
    const res = await fetchWithTimeout(`http://localhost:${port}/`, { method: 'POST', body: form }, 5000, undefined, ['127.0.0.0/8']);
    expect(res.status).toBe(200);
  });

  it('lookup : seules les adresses autorisées sont proposées à la connexion', async () => {
    const result = await new Promise<unknown>((resolve) =>
      guardedLookup(['127.0.0.1'])('localhost', { all: true }, (err, addresses) => resolve(err ? err.message : addresses)),
    );
    // ::1 écarté ; 127.0.0.1 peut apparaître plusieurs fois selon /etc/hosts.
    expect((result as Array<{ address: string }>).map((a) => a.address).every((a) => a === '127.0.0.1')).toBe(true);
    expect((result as unknown[]).length).toBeGreaterThan(0);
  });
});
