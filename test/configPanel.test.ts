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
  hubThreadId: null,
  voiceChannelId: null,
  tagIds: null,
  managerRoleId: '222',
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

  it.each([
    ['forum', ['forum', 'home']],
    ['voice', ['voice', 'home']],
    ['roles', ['roleManager', 'roleOptout', 'roleNudge', 'home']],
    ['reminders', ['remindersEdit', 'home']],
    ['general', ['generalEdit', 'toggleCreators', 'home']],
    ['recording', ['toggleAutoRecord', 'home']],
    ['alerts', ['alerts', 'home']],
  ] as const)('section %s : ses contrôles et le retour', (section, expected) => {
    const view = renderConfigSection(section, c, m);
    expect(ids(view)).toEqual(expected);
    expect(flatten(view).length).toBeLessThanOrEqual(40);
  });

  it('vocal imposé : bouton pour rendre le choix libre ; valeurs actuelles pré-sélectionnées', () => {
    const view = renderConfigSection('voice', { ...c, settings: { ...settings, voiceChannelId: '333' } }, m);
    expect(ids(view)).toEqual(['voice', 'voiceClear', 'home']);
    const select = flatten(view).find((x) => x.type === ComponentType.ChannelSelect)!;
    expect(select.default_values).toEqual([{ id: '333', type: 'channel' }]);
  });

  it('rôles : chaque sélecteur peut être vidé pour retirer le rôle', () => {
    const selects = flatten(renderConfigSection('roles', c, m)).filter((x) => x.type === ComponentType.RoleSelect);
    expect(selects.map((s) => s.min_values)).toEqual([0, 0, 0]);
    expect(selects[0]!.default_values).toEqual([{ id: '222', type: 'role' }]);
  });

  it('message de résultat affiché en haut de la section', () => {
    expect(texts(renderConfigSection('reminders', { ...c, notice: '✅ Enregistré.' }, m))).toContain('✅ Enregistré.');
  });
});
