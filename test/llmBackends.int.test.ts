import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { createDb, runMigrations } from '../src/db/client.js';
import { Repositories } from '../src/db/repositories.js';
import { configureSecrets, encryptSecret } from '../src/lib/secrets.js';
import { effectiveLlms } from '../src/services/llmSettings.js';
import { SettingsService } from '../src/services/settings.js';
import { freshDatabase } from './helpers/db.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Serveurs de résumé (PostgreSQL)', () => {
  let ctx: ReturnType<typeof createDb>;
  let repos: Repositories;
  const config = buildConfig(
    { discord: { token: 'x' }, database: { url: 'postgres://a@b/c' }, defaults: { llm: { baseUrl: 'http://yaml:1234/v1', model: 'yaml-model', chunkTokens: 4000 } } },
    {},
  );

  beforeAll(async () => {
    ctx = createDb(await freshDatabase(url!, 'llmbackends'));
    await runMigrations(ctx.db);
    repos = new Repositories(ctx.db);
  });
  afterAll(async () => {
    configureSecrets(undefined);
    await ctx.pool.end();
  });

  it('sans serveur dans /config : celui du fichier de configuration', async () => {
    const settings = await new SettingsService(repos, config).get('g1');
    const llms = await effectiveLlms(repos, settings, config);
    expect(llms).toMatchObject({ source: 'yaml', enabled: true, servers: [{ name: 'yaml', config: { baseUrl: 'http://yaml:1234/v1', model: 'yaml-model' } }] });
  });

  it('liste de /config : actifs seulement, par priorité, clé déchiffrée, réglages fins du YAML', async () => {
    configureSecrets('secret');
    const settings = await new SettingsService(repos, config).get('g2');
    const a = await repos.addLlmBackend({ guildId: 'g2', name: 'principal', url: 'http://pc:1234/v1', model: 'qwen3', apiKey: encryptSecret('k1') });
    const b = await repos.addLlmBackend({ guildId: 'g2', name: 'secours', url: 'http://nas:11434/v1', model: 'mistral' });
    const c = await repos.addLlmBackend({ guildId: 'g2', name: 'eteint', url: 'http://x/v1', model: 'm' });
    await repos.updateLlmBackend('g2', c.id, { enabled: false });
    await repos.reorderLlmBackends('g2', [b.id, a.id, c.id]);
    const llms = await effectiveLlms(repos, settings, config);
    expect(llms.source).toBe('discord');
    expect(llms.servers.map((s) => [s.name, s.config.model, s.config.apiKey ?? null, s.config.chunkTokens])).toEqual([
      ['secours', 'mistral', null, 4000],
      ['principal', 'qwen3', 'k1', 4000],
    ]);
    await repos.removeLlmBackend('g2', b.id);
    expect((await repos.listLlmBackends('g2')).map((r) => [r.name, r.position])).toEqual([
      ['principal', 0],
      ['eteint', 1],
    ]);
  });
});
