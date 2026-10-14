import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import type { GuildSettingsRow, MeetingRow, ScheduledJobRow } from '../src/db/schema.js';
import { decode } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';
import { Scheduler } from '../src/scheduler/index.js';
import { fakeThread } from './helpers/discordFakes.js';

const m = messages('fr');
const now = new Date('2026-10-14T16:00:00Z');
const meeting = {
  id: '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b', guildId: 'g', threadId: 'thread1', title: 'Bureau', status: 'scheduled', organizerId: '900', targetRoleIds: [] as string[],
  startsAt: new Date('2026-10-15T16:00:00Z'), durationMin: 60, voiceChannelId: 'voice1',
} as MeetingRow;
const settings = {
  guildId: 'g', locale: 'fr', timezone: 'Europe/Paris', reminderOffsetsMin: [1440, 15], nudgeRoleId: null, autoVoiceLeadMin: 15,
} as unknown as GuildSettingsRow;
const job = (offsetMin: number) => ({ id: 1, kind: 'reminder', meetingId: '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b', offsetMin }) as ScheduledJobRow;

function setup(opts: { meeting?: MeetingRow; settings?: GuildSettingsRow; rsvps?: Array<{ userId: string; status: string }>; guild?: unknown; voiceFails?: boolean } = {}) {
  const { thread, sent } = fakeThread();
  const ensureVoice = vi.fn(async () => {
    if (opts.voiceFails) throw new Error('Missing Permissions');
    return { ...meeting, voiceChannelId: 'created' };
  });
  const ctx = {
    config: buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
    log: pino({ level: 'silent' }),
    repos: { getMeeting: async () => opts.meeting ?? meeting, listRsvps: async () => (opts.rsvps ?? []).map((r) => ({ ...r, meetingId: '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b', updatedAt: now })) },
    settings: { get: async () => opts.settings ?? settings },
    client: { channels: { fetch: async () => thread }, guilds: { fetch: async () => opts.guild } },
    meetings: { ensureVoice },
  };
  const scheduler = new Scheduler(ctx as never) as unknown as { run(job: ScheduledJobRow, now: Date): Promise<void> };
  return { scheduler, sent, ensureVoice };
}

const customIds = (payload: Record<string, unknown>) =>
  ((payload.components ?? []) as Array<{ components: Array<{ custom_id?: string; url?: string }> }>).flatMap((row) => row.components.map((c) => c.custom_id ?? c.url ?? ''));

describe('rappels', () => {
  it('mentionne les participants attendus (présents et peut-être), avec les boutons de réponse et le vocal', async () => {
    const { scheduler, sent } = setup({ rsvps: [{ userId: '101', status: 'yes' }, { userId: '102', status: 'maybe' }, { userId: '103', status: 'no' }] });
    await scheduler.run(job(1440), now);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.allowedMentions).toEqual({ users: ['101', '102'] });
    expect(sent[0]!.content).toContain('Bureau');
    const ids = customIds(sent[0]!);
    expect(ids.slice(0, 3).map((id) => decode(id))).toEqual([
      { type: 'rsvp', meetingId: '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b', status: 'yes' },
      { type: 'rsvp', meetingId: '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b', status: 'maybe' },
      { type: 'rsvp', meetingId: '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b', status: 'no' },
    ]);
    expect(ids[3]).toBe('https://discord.com/channels/g/voice1');
  });

  it('réunion commencée ou annulée, ou rappel arrivé trop tard : rien n’est envoyé', async () => {
    for (const over of [{ status: 'live' }, { status: 'cancelled' }, { startsAt: new Date('2026-10-14T15:00:00Z') }]) {
      const { scheduler, sent } = setup({ meeting: { ...meeting, ...over } as MeetingRow });
      await scheduler.run(job(15), now);
      expect(sent).toEqual([]);
    }
  });

  it('salon impossible à créer : le rappel part quand même, sans bouton « Rejoindre »', async () => {
    const pending = { ...meeting, voiceChannelId: null, startsAt: new Date(now.getTime() + 10 * 60_000) } as MeetingRow;
    const { scheduler, sent } = setup({ meeting: pending, voiceFails: true });
    await scheduler.run(job(15), now);
    expect(sent).toHaveLength(1);
    expect(customIds(sent[0]!).some((id) => id.startsWith('https://'))).toBe(false);
  });

  it('plus de 50 personnes sans réponse : le rôle est mentionné s’il peut l’être, sinon leur nombre', async () => {
    const all = new Map(Array.from({ length: 60 }, (_, i) => [String(1000 + i), { id: String(1000 + i), user: { bot: false } }]));
    const role = { mentionable: false, members: Object.assign(all, { filter: (fn: (v: { user: { bot: boolean } }) => boolean) => new Map([...all].filter(([, v]) => fn(v))) }) };
    const roleSettings = { ...settings, nudgeRoleId: 'role' } as GuildSettingsRow;
    const guild = { id: 'g', memberCount: 60, members: { cache: { size: 60 }, fetch: vi.fn() }, roles: { cache: new Map([['role', role]]) } };
    const { scheduler, sent } = setup({ settings: roleSettings, guild });
    await scheduler.run(job(1440), now);
    expect(guild.members.fetch).not.toHaveBeenCalled(); // cache complet : pas de téléchargement
    expect(sent).toHaveLength(2);
    expect(sent[1]!.content).toContain('60 personnes invitées');
    expect(sent[1]!.allowedMentions).toEqual({ parse: [] });

    role.mentionable = true;
    const again = setup({ settings: roleSettings, guild });
    await again.scheduler.run(job(1440), now);
    expect(again.sent[1]!.content).toContain('<@&role>');
    expect(again.sent[1]!.allowedMentions).toEqual({ roles: ['role'] });
  });

  it('salon créé automatiquement : créé avant le rappel qui tombe dans la fenêtre, pour le bouton « Rejoindre »', async () => {
    const pending = { ...meeting, voiceChannelId: null, startsAt: new Date(now.getTime() + 10 * 60_000) } as MeetingRow;
    const { scheduler, sent, ensureVoice } = setup({ meeting: pending });
    await scheduler.run(job(15), now);
    expect(ensureVoice).toHaveBeenCalledWith('3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b');
    expect(customIds(sent[0]!)).toContain('https://discord.com/channels/g/created');
  });

  it('relance des non-répondants en échec (intent manquant) : le rappel part quand même', async () => {
    const guild = { memberCount: 1, members: { cache: new Map(), fetch: async () => Promise.reject(new Error('Used disallowed intents')) }, roles: { cache: new Map() } };
    const { scheduler, sent } = setup({ settings: { ...settings, nudgeRoleId: 'role' } as GuildSettingsRow, guild });
    await scheduler.run(job(1440), now);
    expect(sent).toHaveLength(1);
  });

  it('relance à chaque rappel, sans l’organisateur ni les bots ni ceux qui ont répondu', async () => {
    const member = (id: string, bot = false) => [id, { user: { bot } }] as const;
    // Collection discord.js simulée : une Map avec filter().
    const all = new Map([member('101'), member('900'), member('104'), member('105', true)]);
    const role = { members: Object.assign(all, { filter: (fn: (v: { user: { bot: boolean } }) => boolean) => new Map([...all].filter(([, v]) => fn(v))) }) };
    const guild = { id: 'g', memberCount: 1, members: { cache: new Map(), fetch: async () => undefined }, roles: { cache: new Map([['role', role]]) } };
    const nudging = { ...settings, nudgeRoleId: 'role' } as GuildSettingsRow;
    const first = setup({ settings: nudging, guild, rsvps: [{ userId: '101', status: 'yes' }] });
    await first.scheduler.run(job(1440), now);
    expect(first.sent.at(-1)!.content).toContain(m.thread.nudge);
    expect(first.sent.at(-1)!.allowedMentions).toEqual({ users: ['104'] });
    const later = setup({ settings: nudging, guild, rsvps: [{ userId: '101', status: 'yes' }] });
    await later.scheduler.run(job(15), new Date('2026-10-15T15:45:00Z'));
    expect(later.sent.at(-1)!.allowedMentions).toEqual({ users: ['104'] }); // toujours sans réponse : relancé de nouveau
  });
});

describe('passage du planificateur', () => {
  it('rappels dus ensemble (bot éteint) : seul le plus proche du début part, les autres sont soldés', async () => {
    const { thread, sent } = fakeThread();
    const completeJob = vi.fn(async () => undefined);
    const ctx = {
      config: buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
      log: pino({ level: 'silent' }),
      repos: { getMeeting: async () => ({ ...meeting, startsAt: new Date(Date.now() + 10 * 60_000) }), listRsvps: async () => [], completeJob, failJob: vi.fn() },
      settings: { get: async () => settings },
      client: { channels: { fetch: async () => thread }, guilds: { fetch: async () => undefined } },
      meetings: { ensureVoice: vi.fn() },
    };
    const scheduler = new Scheduler(ctx as never) as unknown as { runMeetingJobs(jobs: ScheduledJobRow[]): Promise<void> };
    await scheduler.runMeetingJobs([{ ...job(1440), id: 1 }, { ...job(15), id: 2 }]);
    expect(sent).toHaveLength(1);
    expect(completeJob.mock.calls.map((c) => (c as unknown[])[0])).toEqual([1, 2]);
  });
});
