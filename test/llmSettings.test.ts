import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import type { GuildSettingsRow } from '../src/db/schema.js';
import { effectiveLlm } from '../src/services/llmSettings.js';

const config = buildConfig(
  { discord: { token: 'x' }, database: { url: 'postgres://a@b/c' }, defaults: { llm: { baseUrl: 'http://litellm:4000/v1', apiKey: 'master', model: 'summary' } } },
  {},
);
const row = (over: Partial<GuildSettingsRow>) => ({ guildId: 'g', llmBaseUrl: null, llmModel: null, llmApiKey: null, llmEnabled: true, ...over }) as GuildSettingsRow;

describe('effectiveLlm', () => {
  it('rien en base : fichier de configuration', () => {
    expect(effectiveLlm(row({}), config)).toMatchObject({ source: 'yaml', enabled: true, config: { baseUrl: 'http://litellm:4000/v1', apiKey: 'master', model: 'summary' } });
  });
  it('modèle choisi seul : adresse et clé du fichier conservées (rien de secret recopié)', () => {
    expect(effectiveLlm(row({ llmModel: 'qwen3:14b' }), config).config).toMatchObject({ baseUrl: 'http://litellm:4000/v1', apiKey: 'master', model: 'qwen3:14b' });
  });
  it('adresse réglée depuis Discord : la clé du fichier ne fuit pas vers un autre serveur', () => {
    const e = effectiveLlm(row({ llmBaseUrl: 'http://pc:1234/v1', llmModel: 'qwen2.5' }), config);
    expect(e).toMatchObject({ source: 'discord', config: { baseUrl: 'http://pc:1234/v1', model: 'qwen2.5' } });
    expect(e.config.apiKey).toBeUndefined();
  });
  it('désactivé', () => {
    expect(effectiveLlm(row({ llmEnabled: false }), config).enabled).toBe(false);
  });
});
