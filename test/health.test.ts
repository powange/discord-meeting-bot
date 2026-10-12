import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { startHealthServer } from '../src/lib/health.js';

describe('serveur de santé', () => {
  it('200 si Discord et la base répondent, 503 sinon', async () => {
    let status = { discord: true, database: true };
    const server = startHealthServer(0, async () => status);
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
    expect((await fetch(url)).status).toBe(200);
    status = { discord: false, database: true };
    const res = await fetch(url);
    expect([res.status, await res.json()]).toEqual([503, { ok: false, discord: false, database: true }]);
    server.close();
  });
});
