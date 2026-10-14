import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import type { GuildSettingsRow, MeetingRow } from '../src/db/schema.js';
import { handleAction } from '../src/discord/interactions/components.js';
import { messages } from '../src/i18n/index.js';
import { fakeInteraction, spyObject } from './helpers/discordFakes.js';

const m = messages('fr');
const meetingId = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
const long = 'Quels moyens y a-t-il pour faire accélérer une chaloupe ?\nPeut-on vraiment modifier les détails ? ' + 'Et ensuite ? '.repeat(60);

describe('« Lire un point » : le détail en entier, en privé, pour tout membre', () => {
  it('bouton → choix du point ; choix → texte complet', async () => {
    const meeting = { id: meetingId, guildId: 'g', title: 'Bureau', status: 'scheduled', organizerId: 'o' } as MeetingRow;
    const ctx = {
      config: buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
      log: pino({ level: 'silent' }),
      settings: { get: async () => ({ guildId: 'g', locale: 'fr', managerRoleIds: [] }) as unknown as GuildSettingsRow, messages: async () => m },
      owners: { isOwner: () => false },
      repos: spyObject({ getMeeting: async () => meeting, listAgenda: async () => [{ id: 7, position: 0, title: 'Ram Strat', detail: long, authorId: '111' }] }),
    };
    const open = fakeInteraction({ kind: 'button', userId: 'member' });
    await handleAction(ctx as never, open.interaction as never, { type: 'agenda.read', meetingId });
    const text = (payload: unknown) => JSON.stringify(payload);
    expect(open.replies.at(-1)).toMatchObject({ how: 'reply', payload: { flags: 64 | 32768 } });
    expect(text(open.replies.at(-1)!.payload)).toContain(m.card.readPick);

    const pick = fakeInteraction({ kind: 'select', userId: 'member', values: ['7'] });
    await handleAction(ctx as never, pick.interaction as never, { type: 'agenda.readSelect', meetingId });
    const content = ((pick.replies.at(-1)!.payload as { components: Array<{ components: Array<{ content?: string }> }> }).components[0]!.components[0]!.content)!;
    expect(content).toContain('**1. Ram Strat** — proposé par <@111>');
    expect(content).toContain(`> ${long.split('\n')[1]!.trimEnd()}`); // en entier, sans coupure
    expect(content).not.toContain('…');
  });
});

describe('gestion de l’ordre du jour : panneau mis à jour sur place', () => {
  const meeting = { id: meetingId, guildId: 'g', title: 'Bureau', status: 'scheduled', organizerId: 'organizer', agendaLocked: false } as MeetingRow;
  let agenda = [
    { id: 7, position: 0, title: 'Premier point', detail: '', authorId: '111' },
    { id: 8, position: 1, title: 'Deuxième point', detail: '', authorId: '111' },
  ];
  const ctx = {
    config: buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
    log: pino({ level: 'silent' }),
    settings: { get: async () => ({ guildId: 'g', locale: 'fr', managerRoleIds: [] }) as unknown as GuildSettingsRow, messages: async () => m },
    owners: { isOwner: () => false },
    cards: spyObject(),
    repos: spyObject({
      getMeeting: async () => meeting,
      listAgenda: async () => agenda,
      reorderAgenda: async (_id: string, ids: number[]) => void (agenda = agenda.filter((a) => ids.includes(a.id))),
    }),
  };

  it('« Annuler » depuis le panneau : mise à jour du panneau, pas de nouveau message ; depuis la carte : nouveau panneau', async () => {
    const fromPanel = fakeInteraction({ kind: 'button', userId: 'organizer' });
    await handleAction(ctx as never, fromPanel.interaction as never, { type: 'agenda.manage', meetingId });
    expect(fromPanel.replies.map((r) => r.how)).toEqual(['update']);

    const fromCard = fakeInteraction({ kind: 'button', userId: 'organizer', messageFlags: 0 });
    await handleAction(ctx as never, fromCard.interaction as never, { type: 'agenda.manage', meetingId });
    expect(fromCard.replies.map((r) => r.how)).toEqual(['reply']);
  });

  it('retrait confirmé : le panneau dit quel point a été retiré', async () => {
    const confirm = fakeInteraction({ kind: 'button', userId: 'organizer' });
    await handleAction(ctx as never, confirm.interaction as never, { type: 'agenda.removeConfirm', meetingId, itemId: 7 });
    expect(JSON.stringify(confirm.replies.at(-1)!.payload)).toContain(`✅ ${m.agendaManager.removed('Premier point')}`);
    expect(agenda.map((a) => a.id)).toEqual([8]);
  });
});
