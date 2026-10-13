import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import type { GuildSettingsRow, MeetingRow } from '../src/db/schema.js';
import { MeetingService } from '../src/services/meetings.js';

// Faux objets minimaux : seules les méthodes utilisées par le cycle de vie du salon temporaire.
const config = buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {});
const log = pino({ level: 'silent' });
const discordError = (code: number) => Object.assign(new Error(`Discord ${code}`), { code });

const settings = (over: Partial<GuildSettingsRow> = {}) =>
  ({ guildId: 'g', locale: 'fr', timezone: 'Europe/Paris', reminderOffsetsMin: [], autoVoice: true, autoVoiceLeadMin: 15, voiceChannelId: null, autoVoiceCategoryId: null, forumChannelId: null, ...over }) as GuildSettingsRow;

const meetingRow = (over: Partial<MeetingRow> = {}) =>
  ({
    id: 'm1', guildId: 'g', threadId: null, title: 'Bureau', description: '', status: 'ended', voiceChannelId: 'temp', voiceTemporary: true, voiceDeletedAt: null,
    startsAt: new Date('2026-10-15T16:00:00Z'), durationMin: 60, organizerId: 'u1', scheduledEventId: null, autoRecord: false, ...over,
  }) as MeetingRow;

function voiceChannel(id: string, humans = 0) {
  const deleted: string[] = [];
  const members = { filter: () => ({ size: humans }) };
  return { id, deleted, channel: { id, isVoiceBased: () => true, isThread: () => false, members, delete: async () => void deleted.push(id) } };
}

function setup(opts: { settings?: GuildSettingsRow; meeting?: MeetingRow; channels?: Record<string, unknown>; fetchError?: Error }) {
  let meeting = opts.meeting ?? meetingRow();
  const updates: Array<Partial<MeetingRow>> = [];
  const created: string[] = [];
  const repos = {
    getMeeting: async () => meeting,
    updateMeeting: async (_id: string, patch: Partial<MeetingRow>) => {
      updates.push(patch);
      meeting = { ...meeting, ...patch };
      return meeting;
    },
    replaceJobs: async () => undefined,
    listRsvps: async () => [],
  };
  const guild = {
    id: 'g',
    channels: { create: async () => (created.push('new'), { id: 'new' }) },
    scheduledEvents: { edit: async () => ({}), create: async () => ({ id: 'ev' }) },
  };
  const client = {
    channels: {
      fetch: async (id: string) => {
        if (opts.fetchError) throw opts.fetchError;
        if (id in (opts.channels ?? {})) return (opts.channels ?? {})[id];
        throw discordError(10003);
      },
    },
    guilds: { fetch: async () => guild },
  };
  const s = opts.settings ?? settings();
  const service = new MeetingService(
    config,
    client as never,
    repos as never,
    { get: async () => s } as never,
    { refresh: () => undefined, refreshNow: async () => undefined } as never,
    log,
  );
  return { service, updates, created, guild, current: () => meeting };
}

describe('salon vocal temporaire', () => {
  it('fin de réunion : salon vide supprimé et marqué', async () => {
    const temp = voiceChannel('temp');
    const { service, updates } = setup({ channels: { temp: temp.channel } });
    expect(await service.deleteTemporaryVoice(meetingRow())).toBe(true);
    expect(temp.deleted).toEqual(['temp']);
    expect(updates.at(-1)).toHaveProperty('voiceDeletedAt');
  });

  it('jamais le salon imposé par /config, même marqué temporaire', async () => {
    const fixed = voiceChannel('fixed');
    const { service } = setup({ settings: settings({ autoVoice: false, voiceChannelId: 'fixed' }), meeting: meetingRow({ voiceChannelId: 'fixed' }), channels: { fixed: fixed.channel } });
    await service.deleteTemporaryVoice(meetingRow({ voiceChannelId: 'fixed' }));
    expect(fixed.deleted).toEqual([]);
  });

  it('salon occupé ou erreur passagère de Discord : rien de supprimé ni de marqué, on réessaiera', async () => {
    const busy = voiceChannel('temp', 2);
    const a = setup({ channels: { temp: busy.channel } });
    expect(await a.service.deleteTemporaryVoice(meetingRow())).toBe(false);
    expect(a.updates).toEqual([]);
    const b = setup({ fetchError: discordError(500) });
    expect(await b.service.deleteTemporaryVoice(meetingRow())).toBe(false);
    expect(b.updates).toEqual([]);
  });

  it('erreur passagère au moment de vérifier le salon : pas de second salon créé', async () => {
    const { service, created } = setup({ meeting: meetingRow({ status: 'scheduled' }), fetchError: discordError(500) });
    await service.ensureVoice('m1');
    expect(created).toEqual([]);
  });

  it('salon supprimé à la main avant la fin : recréé', async () => {
    const { service, created, current } = setup({ meeting: meetingRow({ status: 'scheduled' }) });
    await service.ensureVoice('m1');
    expect(created).toEqual(['new']);
    expect(current()).toMatchObject({ voiceChannelId: 'new', voiceTemporary: true });
  });

  it('modification après passage en mode « imposé » : le salon n’est plus temporaire, l’ancien est supprimé', async () => {
    const temp = voiceChannel('temp');
    const fixed = voiceChannel('fixed');
    const scheduled = meetingRow({ status: 'scheduled' });
    const { service, current, guild } = setup({
      settings: settings({ autoVoice: false, voiceChannelId: 'fixed' }),
      meeting: scheduled,
      channels: { temp: temp.channel, fixed: fixed.channel },
    });
    await service.update(guild as never, scheduled, { title: 'Bureau', description: '', startsAt: scheduled.startsAt, durationMin: 60, voiceChannelId: 'temp' }, 'u1');
    expect(current()).toMatchObject({ voiceChannelId: 'fixed', voiceTemporary: false });
    expect(temp.deleted).toEqual(['temp']);
    // À la fin, le salon imposé n'est pas supprimé.
    expect(await service.deleteTemporaryVoice({ ...current(), status: 'ended' })).toBe(false);
    expect(fixed.deleted).toEqual([]);
  });
});
