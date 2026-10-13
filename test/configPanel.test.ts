import { ComponentType, type APIContainerComponent } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { GuildSettingsRow } from '../src/db/schema.js';
import { CONFIG_SECTIONS, renderConfigHome, renderConfigSection, type ConfigContext } from '../src/discord/embeds/configPanel.js';
import { decode } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');
const settings: GuildSettingsRow = {
  guildId: 'g',
  forumChannelId: '111',
  alertChannelId: null,
  llmBaseUrl: null,
  llmModel: null,
  llmApiKey: null,
  llmEnabled: true,
  hubThreadId: null,
  voiceChannelId: null,
  autoVoice: false,
  autoVoiceCategoryId: null,
  autoVoiceLeadMin: 15,
  vocabulary: [],
  tagIds: null,
  managerRoleId: null,
  managerRoleIds: ['222'],
  optoutRoleId: null,
  nudgeRoleId: null,
  creatorsRestricted: false,
  timezone: 'Europe/Paris',
  locale: 'fr',
  reminderOffsetsMin: [1440, 15],
  defaultDurationMin: 90,
  autoRecordDefault: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const c: ConfigContext = { settings, transcription: '1 actif : vibe-pc' };
const chans = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: String(100 + i), name: 'commands', position: i, category: { name: `Catégorie ${i}`, position: i } }));
const withChannels = (n: number, page = 0): ConfigContext => ({ ...c, channels: { list: chans(n), page } });

function flatten(x: { type: number; components?: unknown[]; accessory?: unknown }): Array<Record<string, unknown> & { type: number }> {
  return [x as never, ...[...((x.components as never[]) ?? []), ...(x.accessory ? [x.accessory as never] : [])].flatMap((y) => flatten(y))];
}
const texts = (p: APIContainerComponent) => flatten(p).filter((x) => x.type === ComponentType.TextDisplay).map((x) => x.content as string).join('\n');
const ids = (p: APIContainerComponent) =>
  flatten(p)
    .filter((x) => typeof x.custom_id === 'string')
    .map((x) => {
      const a = decode(x.custom_id as string);
      return a?.type === 'cfg' ? a.action : '?';
    });

describe('panneau /config', () => {
  it('accueil : toutes les sections résumées et un menu pour en choisir une', () => {
    const home = renderConfigHome(c, m);
    const t = texts(home);
    expect(t).toContain('**Forum des réunions** · <#111>');
    expect(t).toContain('**Salon vocal** · *au choix de l’organisateur*');
    expect(t).toContain('Gestionnaires <@&222>');
    expect(t).toContain('**Rappels** · 1 j, 15 min');
    expect(t).toContain('Europe/Paris · 1 h 30 · création : tout le monde');
    expect(t).toContain('**Transcription** · 1 actif : vibe-pc');
    const select = flatten(home).find((x) => x.type === ComponentType.StringSelect)!;
    expect((select.options as Array<{ value: string }>).map((o) => o.value)).toEqual([...CONFIG_SECTIONS]);
  });

  it('accueil : « À faire » liste ce qui manque, dans l’ordre ; rien quand tout est réglé', () => {
    const fresh = texts(renderConfigHome({ ...c, settings: { ...settings, forumChannelId: null, managerRoleIds: [] } }, m));
    expect(fresh).toContain(m.config.todo.title);
    expect(fresh.indexOf('Forum des réunions** : sans lui')).toBeLessThan(fresh.indexOf('**Alertes** : un salon'));
    expect(texts(renderConfigHome({ ...c, settings: { ...settings, alertChannelId: '333' } }, m))).not.toContain(m.config.todo.title);
  });

  it.each([
    ['forum', ['forum', 'home']],
    ['voice', ['voiceMode', 'home']],
    ['alerts', ['alerts', 'home']],
    ['roles', ['roleManager', 'roleNudge', 'home']],
    ['reminders', ['remindersEdit', 'home']],
    ['general', ['generalEdit', 'toggleCreators', 'home']],
    ['recording', ['toggleAutoRecord', 'home']],
  ] as const)('section %s : ses contrôles et le retour', (section, expected) => {
    const view = renderConfigSection(section, withChannels(3), m);
    expect(ids(view)).toEqual(expected);
    expect(flatten(view).length).toBeLessThanOrEqual(40);
  });

  it('salons homonymes : précédés de leur catégorie ; valeur actuelle présélectionnée', () => {
    const view = renderConfigSection('alerts', { ...withChannels(3), settings: { ...settings, alertChannelId: '101' } }, m);
    const select = flatten(view).find((x) => x.type === ComponentType.StringSelect)!;
    const options = select.options as Array<{ label: string; value: string; default?: boolean }>;
    expect(options.map((o) => o.label)).toEqual(['Catégorie 0 › #commands', 'Catégorie 1 › #commands', 'Catégorie 2 › #commands']);
    expect(options.find((o) => o.default)?.value).toBe('101');
    expect(ids(view)).toEqual(['alerts', 'alertsTest', 'alertsClear', 'home']);
  });

  it('plus de 25 salons : pagination', () => {
    const view = renderConfigSection('alerts', withChannels(60, 1), m);
    const select = flatten(view).find((x) => x.type === ComponentType.StringSelect)!;
    expect((select.options as unknown[]).length).toBe(25);
    expect(select.placeholder).toContain('page 2/3');
    const pageButtons = flatten(view)
      .filter((x) => x.type === ComponentType.Button && typeof x.custom_id === 'string' && (x.custom_id as string).includes(':page:'))
      .map((x) => x.custom_id);
    expect(pageButtons).toEqual(['v1:cfg:page:alerts.0', 'v1:cfg:page:alerts.2']);
  });

  it('vocal : mode au choix, imposé (liste des salons) ou créé automatiquement (catégorie, délai)', () => {
    expect(ids(renderConfigSection('voice', { ...withChannels(2), settings }, m))).toEqual(['voiceMode', 'home']);
    const fixed = renderConfigSection('voice', { ...withChannels(2), settings: { ...settings, voiceChannelId: '100' } }, m);
    expect(ids(fixed)).toEqual(['voiceMode', 'voice', 'home']);
    // « Imposé » choisi, salon pas encore désigné : la liste apparaît quand même.
    expect(ids(renderConfigSection('voice', { ...withChannels(2), settings, voiceMode: 'fixed' }, m))).toEqual(['voiceMode', 'voice', 'home']);

    const auto = renderConfigSection('voice', { ...c, settings: { ...settings, autoVoice: true, autoVoiceCategoryId: '900', autoVoiceLeadMin: 30 } }, m);
    expect(ids(auto)).toEqual(['voiceMode', 'voiceCategory', 'voiceLead', 'home']);
    const category = flatten(auto).find((x) => x.type === ComponentType.ChannelSelect)!;
    expect(category.default_values).toEqual([{ id: '900', type: 'channel' }]);
    expect(category.min_values).toBe(0);
    expect(texts(auto)).toContain('créé automatiquement 30 min avant · catégorie <#900>');
  });

  it('rôles : chaque sélecteur peut être vidé pour retirer le rôle', () => {
    const selects = flatten(renderConfigSection('roles', c, m)).filter((x) => x.type === ComponentType.RoleSelect);
    expect(selects.map((s) => s.min_values)).toEqual([0, 0]);
    expect(selects[0]!.default_values).toEqual([{ id: '222', type: 'role' }]);
  });

  it('résumé : propriétaire → modifier, choisir le modèle, tester, désactiver ; admin → tester et désactiver', () => {
    const llm = { source: 'discord' as const, enabled: true, baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen2.5-14b-instruct', hasKey: false };
    expect(ids(renderConfigSection('summary', { ...c, llm, canEditAi: true }, m))).toEqual(['llmEdit', 'llmModels', 'llmTest', 'llmToggle', 'llmReset', 'home']);
    expect(ids(renderConfigSection('summary', { ...c, llm, canEditAi: false }, m))).toEqual(['llmTest', 'llmToggle', 'home']);
    expect(texts(renderConfigHome({ ...c, llm }, m))).toContain('**Résumé** · qwen2.5-14b-instruct');
    expect(texts(renderConfigHome({ ...c, llm: { ...llm, enabled: false } }, m))).toContain('**Résumé** · désactivé');
  });

  it('résumé : liste des modèles proposée après « Choisir le modèle »', () => {
    const llm = { source: 'yaml' as const, enabled: true, baseUrl: 'http://x/v1', model: 'b', hasKey: false };
    const view = renderConfigSection('summary', { ...c, llm, canEditAi: true, models: ['a', 'b'] }, m);
    const select = flatten(view).find((x) => x.type === ComponentType.StringSelect)!;
    expect((select.options as Array<{ value: string; default?: boolean }>).map((o) => [o.value, o.default ?? false])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('enregistrement : liste des personnes qui refusent', () => {
    const view = renderConfigSection('recording', { ...c, refusals: ['501', '502'] }, m);
    expect(texts(view)).toContain('🔇 2 personnes refusent');
    expect(texts(view)).toContain('<@501> <@502>');
  });

  it('message de résultat affiché en haut de la section', () => {
    expect(texts(renderConfigSection('reminders', { ...c, notice: '✅ Enregistré.' }, m))).toContain('✅ Enregistré.');
  });
});
