import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import type { GuildSettingsRow } from '../src/db/schema.js';
import { effectiveLlm } from '../src/services/llmSettings.js';

const config = buildConfig(
  { discord: { token: 'x' }, database: { url: 'postgres://a@b/c' }, defaults: { llm: { baseUrl: 'http://litellm:4000/v1', apiKey: 'master', model: 'summary' } } },
  {},
);
const row = (over: Partial<GuildSettingsRow>) => ({ guildId: 'g', llmEnabled: true, ...over }) as GuildSettingsRow;

describe('effectiveLlm', () => {
  it('rien en base : fichier de configuration', () => {
    expect(effectiveLlm(row({}), config)).toMatchObject({ source: 'yaml', enabled: true, config: { baseUrl: 'http://litellm:4000/v1', apiKey: 'master', model: 'summary' } });
  });
  it('désactivé', () => {
    expect(effectiveLlm(row({ llmEnabled: false }), config).enabled).toBe(false);
  });
});
