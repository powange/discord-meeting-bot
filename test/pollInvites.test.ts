import { PermissionFlagsBits } from 'discord.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import type { MeetingRow } from '../src/db/schema.js';
import { renderMeetingManager } from '../src/discord/embeds/meetingManager.js';
import { decode } from '../src/domain/customId.js';
import { nudgeRoles } from '../src/domain/rsvp.js';
import { messages } from '../src/i18n/index.js';
import { MeetingService } from '../src/services/meetings.js';
import { fakeThread } from './helpers/discordFakes.js';

const m = messages('fr');

describe('rôles invités à répondre à un sondage', () => {
  it('relance : les rôles invités remplacent le rôle de relance du serveur', () => {
    expect(nudgeRoles({ targetRoleIds: ['r1', 'r2'] }, { nudgeRoleId: 'srv' })).toEqual(['r1', 'r2']);
    expect(nudgeRoles({ targetRoleIds: [] }, { nudgeRoleId: 'srv' })).toEqual(['srv']);
    expect(nudgeRoles({ targetRoleIds: [] }, { nudgeRoleId: null })).toEqual([]);
  });

  it('⚙️ Gérer d’un sondage : sélecteur des rôles invités, valeurs actuelles présélectionnées', () => {
    // @everyone (identifiant du serveur, « g ») : bouton à part, jamais dans le sélecteur.
    const panel = renderMeetingManager({ id: '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b', guildId: 'g', title: 'AG', status: 'polling', autoRecord: false, targetRoleIds: ['111', 'g'] }, { hasRecording: false }, m);
    const rows = panel.components.filter((c) => c.type === 1) as Array<{ components: Array<{ type: number; custom_id: string; default_values?: Array<{ id: string }> }> }>;
    const select = rows.flatMap((r) => r.components).find((c) => c.type === 6)!;
    expect(decode(select.custom_id)?.type).toBe('poll.roles');
    expect(select.default_values).toEqual([{ id: '111', type: 'role' }]);
    const everyone = rows.flatMap((r) => r.components).find((c) => c.type === 2 && decode(c.custom_id)?.type === 'poll.everyone') as unknown as { label: string };
    expect(everyone.label).toBe(m.datePoll.everyoneOff);
  });

  function setup(opts: { mentionable: boolean; canMentionAll?: boolean; current?: string[] }) {
    const t = fakeThread('post');
    let meeting = { id: 'm1', guildId: 'g', threadId: 'post', status: 'polling', title: 'AG', targetRoleIds: opts.current ?? [] } as unknown as MeetingRow;
    const members = new Map([
      ['111111111111111111', { id: '111111111111111111', user: { bot: false } }],
      ['b1', { id: 'b1', user: { bot: true } }],
    ]);
    const role = (id: string) => ({ id, mentionable: opts.mentionable, members: { filter: (fn: (x: { user: { bot: boolean } }) => boolean) => new Map([...members].filter(([, v]) => fn(v))) } });
    const guild = {
      id: 'g',
      members: { me: { permissions: { has: (flag: bigint) => flag === PermissionFlagsBits.MentionEveryone && (opts.canMentionAll ?? false) } }, fetch: async () => undefined },
      roles: { cache: { get: (id: string) => role(id) } },
    };
    const service = new MeetingService(
      buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
      { channels: { fetch: async () => t.thread } } as never,
      { getMeeting: async () => meeting, updateMeeting: async (_id: string, p: Partial<MeetingRow>) => (meeting = { ...meeting, ...p }) } as never,
      { messages: async () => m, get: async () => ({ guildId: 'g', locale: 'fr' }) } as never,
      {} as never,
      pino({ level: 'silent' }),
    );
    return { service, guild, t, meeting: () => meeting };
  }

  it('rôle mentionnable : enregistré et mentionné (notification du rôle)', async () => {
    const s = setup({ mentionable: true });
    await s.service.inviteRoles(s.guild as never, 'm1', ['r1']);
    expect(s.meeting().targetRoleIds).toEqual(['r1']);
    expect(s.t.sent).toEqual([{ content: m.datePoll.invite('<@&r1>'), allowedMentions: { roles: ['r1'] } }]);
  });

  it('rôle non mentionnable, sans la permission : ses membres (hors bots) mentionnés un par un', async () => {
    const s = setup({ mentionable: false });
    await s.service.inviteRoles(s.guild as never, 'm1', ['r1']);
    expect(s.t.sent).toHaveLength(1);
    expect(s.t.sent[0]).toMatchObject({ content: `${m.datePoll.invite('<@&r1>')}\n${m.datePoll.invitedMembers} <@111111111111111111>`, allowedMentions: { users: ['111111111111111111'] } });
  });

  it('rôles déjà invités : pas mentionnés à nouveau ; liste vidée : plus de rôle invité', async () => {
    const s = setup({ mentionable: true, current: ['r1'] });
    await s.service.inviteRoles(s.guild as never, 'm1', ['r1', 'r2']);
    expect(s.t.sent).toEqual([{ content: m.datePoll.invite('<@&r2>'), allowedMentions: { roles: ['r2'] } }]);
    await s.service.inviteRoles(s.guild as never, 'm1', []);
    expect(s.meeting().targetRoleIds).toEqual([]);
    expect(s.t.sent).toHaveLength(1);
  });

  it('@everyone avec la permission « Mentionner @everyone » : une vraie mention @everyone', async () => {
    const s = setup({ mentionable: false, canMentionAll: true });
    await s.service.inviteRoles(s.guild as never, 'm1', ['g']);
    expect(s.t.sent).toEqual([{ content: m.datePoll.invite('@everyone'), allowedMentions: { roles: [], parse: ['everyone'] } }]);
  });

  it('@everyone sans la permission : les membres (hors bots) un par un, jamais de mention générale', async () => {
    const s = setup({ mentionable: true });
    await s.service.inviteRoles(s.guild as never, 'm1', ['g']);
    expect(s.t.sent).toHaveLength(1);
    expect(s.t.sent[0]).toMatchObject({ content: `${m.datePoll.invite('@everyone')}\n${m.datePoll.invitedMembers} <@111111111111111111>`, allowedMentions: { users: ['111111111111111111'] } });
  });
});
