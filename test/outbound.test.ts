import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { errorSnippet, hostOf } from '../src/lib/hosts.js';

describe('appels sortants', () => {
  it('AI_ALLOWED_HOSTS (sans YAML) : liste séparée par des virgules', () => {
    const raw = { discord: { token: 'x' }, database: { url: 'postgres://a@b/c' }, ai: { allowedHosts: '192.168.0.0/24, *.tailnet ,' } };
    expect(buildConfig(raw, {}).ai.allowedHosts).toEqual(['192.168.0.0/24', '*.tailnet']);
    expect(buildConfig({ ...raw, ai: { allowedHosts: '' } }, {}).ai.allowedHosts).toEqual([]);
  });

  it('erreurs : seul le message d’erreur JSON est repris, jamais une page brute', () => {
    expect(errorSnippet('{"error":{"message":"model \\"qwen3\\" not found"}}')).toBe('model "qwen3" not found');
    expect(errorSnippet('{"detail":"busy"}')).toBe('busy');
    expect(errorSnippet('<html><body>Portainer admin</body></html>')).toBe('');
    expect(errorSnippet(`{"error":"${'x'.repeat(500)}"}`)).toHaveLength(120);
  });

  it('hôte d’une adresse (changement d’hôte = clé effacée)', () => {
    expect(hostOf('http://192.168.0.11:1234/v1')).toBe('192.168.0.11:1234');
    expect(hostOf('http://PC.local:1234/v1')).toBe(hostOf('http://pc.local:1234/other'));
  });
});
