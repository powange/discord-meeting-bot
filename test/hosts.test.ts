import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, hostMatches } from '../src/lib/hosts.js';

const patterns = ['*.tailnet.ts.net', 'pc-main', '192.168.1.0/24', '100.64.0.0/10', '10.0.0.5'];

describe('hostMatches', () => {
  it.each([
    ['gpu.tailnet.ts.net', true],
    ['tailnet.ts.net', false], // le joker exige un sous-domaine
    ['evil-tailnet.ts.net', false],
    ['PC-MAIN', true],
    ['192.168.1.42', true],
    ['192.168.2.1', false],
    ['100.101.102.103', true],
    ['10.0.0.5', true],
    ['10.0.0.6', false],
    ['127.0.0.1', false],
  ])('%s → %s', (host, expected) => {
    expect(hostMatches(host, patterns)).toBe(expected);
  });
});

describe('assertUrlAllowed', () => {
  const resolver = (map: Record<string, string[]>) => async (h: string) => map[h] ?? [];

  it('liste vide : tout est permis', async () => {
    await expect(assertUrlAllowed('http://n-importe-quoi:8080', [])).resolves.toBeUndefined();
  });
  it('nom autorisé ou IP autorisée', async () => {
    await expect(assertUrlAllowed('http://gpu.tailnet.ts.net:8080', patterns)).resolves.toBeUndefined();
    await expect(assertUrlAllowed('http://192.168.1.10:8080/v1', patterns)).resolves.toBeUndefined();
  });
  it('nom inconnu résolu vers une IP autorisée : accepté', async () => {
    await expect(assertUrlAllowed('http://nas.local:5000', patterns, resolver({ 'nas.local': ['192.168.1.3'] }))).resolves.toBeUndefined();
  });
  it('nom qui résout (même en partie) hors des plages autorisées : refusé', async () => {
    await expect(assertUrlAllowed('http://x.example', patterns, resolver({ 'x.example': ['192.168.1.3', '8.8.8.8'] }))).rejects.toThrow(/non autorisé/);
    await expect(assertUrlAllowed('http://127.0.0.1:5432', patterns)).rejects.toThrow(/non autorisé/);
  });
});
