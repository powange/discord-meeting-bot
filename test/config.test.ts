import { describe, expect, it } from 'vitest';
import { buildConfig, ConfigError } from '../src/config/index.js';
import { deepMerge, interpolateEnv } from '../src/config/env.js';

const env = { DISCORD_TOKEN: 'tok', DATABASE_URL: 'postgres://u:p@db/x' };
const minimal = { discord: { token: '${DISCORD_TOKEN}' }, database: { url: '${DATABASE_URL}' } };
const G1 = '111111111111111111';

describe('interpolateEnv', () => {
  it('remplace les variables et applique les défauts', () => {
    const missing = new Set<string>();
    expect(interpolateEnv({ a: 'x-${A}-${B:-def}', b: ['${A}'], c: 3 }, { A: '1' }, missing)).toEqual({ a: 'x-1-def', b: ['1'], c: 3 });
    expect(missing.size).toBe(0);
  });

  it('collecte les variables manquantes avec leur chemin', () => {
    const missing = new Set<string>();
    interpolateEnv({ db: { url: '${NOPE}' } }, {}, missing);
    expect([...missing]).toEqual(['NOPE (db.url)']);
  });

  it('une variable vide compte comme absente', () => {
    const missing = new Set<string>();
    expect(interpolateEnv('${E:-fallback}', { E: '' }, missing)).toBe('fallback');
  });
});

describe('deepMerge', () => {
  it('fusionne les objets, remplace tableaux et scalaires', () => {
    expect(deepMerge({ a: { x: 1, y: [1, 2] }, b: 1 }, { a: { y: [3] }, c: 2 })).toEqual({ a: { x: 1, y: [3] }, b: 1, c: 2 });
  });
});

describe('buildConfig', () => {
  it('applique les valeurs par défaut', () => {
    const c = buildConfig(minimal, env);
    expect(c.discord).toEqual({ token: 'tok', commandGuildIds: [] });
    expect(c.scheduler.tickSeconds).toBe(30);
    expect(c.guild(G1).seed).toEqual({
      timezone: 'Europe/Paris',
      locale: 'fr',
      reminderOffsetsMin: [1440, 15],
      defaultDurationMin: 60,
      autoRecordDefault: false,
    });
  });

  it('fusionne defaults et surcharge par serveur', () => {
    const c = buildConfig(
      { ...minimal, defaults: { seed: { timezone: 'Europe/Brussels', defaultDurationMin: 90 } }, guilds: { [G1]: { seed: { defaultDurationMin: 30 } } } },
      env,
    );
    expect(c.guild(G1).seed).toMatchObject({ timezone: 'Europe/Brussels', defaultDurationMin: 30 });
    expect(c.guild('222222222222222222').seed).toMatchObject({ timezone: 'Europe/Brussels', defaultDurationMin: 90 });
  });

  it('langue de transcription : code ISO ou « auto »', () => {
    expect(buildConfig({ ...minimal, defaults: { transcription: { language: 'auto' } } }, env).guild(G1).transcription.language).toBe('auto');
    expect(() => buildConfig({ ...minimal, defaults: { transcription: { language: 'français' } } }, env)).toThrow(ConfigError);
  });

  it('signale toutes les variables manquantes', () => {
    expect(() => buildConfig(minimal, {})).toThrow(/DISCORD_TOKEN.*DATABASE_URL/);
  });

  it('refuse les clés inconnues et valeurs invalides, avec le chemin', () => {
    expect(() => buildConfig({ ...minimal, typo: 1 }, env)).toThrow(ConfigError);
    expect(() => buildConfig({ ...minimal, guilds: { [G1]: { seed: { timezone: 'Mars/Olympus' } } } }, env)).toThrow(/guilds\.111111111111111111[\s\S]*fuseau/);
    expect(() => buildConfig({ ...minimal, guilds: { 'pas-un-id': {} } }, env)).toThrow(ConfigError);
    expect(() => buildConfig({ ...minimal, database: { url: 'mysql://x' } }, env)).toThrow(/PostgreSQL/);
  });
});
