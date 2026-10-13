import { ChannelType } from 'discord.js';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { createDb, runMigrations } from '../src/db/client.js';
import { Repositories } from '../src/db/repositories.js';
import { CardService } from '../src/services/cards.js';
import { MeetingService } from '../src/services/meetings.js';
import { SettingsService } from '../src/services/settings.js';
import { freshDatabase } from './helpers/db.js';
import { fakeThread } from './helpers/discordFakes.js';

const url = process.env.TEST_DATABASE_URL;
const log = pino({ level: 'silent' });

describe.skipIf(!url)('Sondage de date : du sondage à la réunion planifiée', () => {
  let ctx: ReturnType<typeof createDb>;
  let repos: Repositories;
  let service: MeetingService;
  const threads: Array<ReturnType<typeof fakeThread>> = [];
  const guild = { id: 'g', scheduledEvents: { create: vi.fn(async () => ({ id: 'event1' })), edit: vi.fn() }, members: { fetch: vi.fn(async () => ({ displayName: 'Orga' })) }, roles: { cache: new Map() } };

  beforeAll(async () => {
    ctx = createDb(await freshDatabase(url!, 'datepoll'));
    await runMigrations(ctx.db);
    repos = new Repositories(ctx.db);
    const config = buildConfig({ discord: { token: 'x' }, database: { url: url! } }, {});
    const settings = new SettingsService(repos, config);
    await settings.get('g');
    await repos.updateSettings('g', { forumChannelId: 'forum', tagIds: { upcoming: 'tU', live: 'tL', ended: 'tE', cancelled: 'tC', polling: 'tP' } });
    const forum = {
      type: ChannelType.GuildForum,
      threads: {
        create: vi.fn(async () => {
          const t = fakeThread(`thread${threads.length + 1}`);
          Object.assign(t.thread, { url: `https://discord.com/channels/g/${t.thread.id}`, appliedTags: ['tP'], setAppliedTags: vi.fn(async () => undefined) });
          threads.push(t);
          return t.thread;
        }),
      },
    };
    const client = {
      channels: { fetch: async (id: string) => (id === 'forum' ? forum : (threads.find((t) => t.thread.id === id)?.thread ?? null)) },
      guilds: { fetch: async () => guild },
    };
    // Rendu réel des cartes ; leurs mises à jour Discord ne sont pas l'objet de ce test.
    const cards = new CardService(client as never, repos, settings, log);
    cards.refresh = () => undefined;
    cards.refreshNow = async () => undefined;
    service = new MeetingService(config, client as never, repos, settings, cards, log);
  });
  afterAll(async () => ctx.pool.end());

  const slotsInput = [
    { startsAt: new Date(Date.now() + 5 * 86_400_000), durationMin: 60 },
    { startsAt: new Date(Date.now() + 6 * 86_400_000), durationMin: 90 },
  ];

  it('création : post « Date à choisir », créneaux, relance et clôture planifiées, pas d’événement', async () => {
    const closesAt = new Date(Date.now() + 3 * 86_400_000);
    const meeting = await service.createPoll(guild as never, 'organizer', { title: 'AG', description: '', voiceChannelId: 'v', slots: slotsInput, closesAt });
    expect(meeting).toMatchObject({ status: 'polling', threadId: 'thread1', pollClosesAt: closesAt });
    expect(threads[0]!.thread).toBeDefined();
    expect((await repos.listSlots(meeting.id)).map((s) => s.durationMin)).toEqual([60, 90]);
    const jobs = await ctx.pool.query(`select kind::text from scheduled_jobs where meeting_id = '${meeting.id}' order by due_at`);
    expect(jobs.rows.map((r) => r.kind)).toEqual(['poll_nudge', 'poll_close']);
    expect(guild.scheduledEvents.create).not.toHaveBeenCalled();
  });

  it('clôture : meilleur créneau retenu, réponses reprises en inscriptions, réunion planifiée et annoncée', async () => {
    const [meeting] = await repos.listMeetings('g', ['polling']);
    const [s1, s2] = await repos.listSlots(meeting!.id);
    await repos.setVote(s1!.id, '101', 'yes');
    await repos.setVote(s1!.id, '102', 'maybe');
    await repos.setVote(s2!.id, '103', 'yes');
    await repos.setVote(s2!.id, '101', 'no');

    await service.closePoll(meeting!.id);
    const fixed = await repos.getMeeting(meeting!.id);
    expect(fixed).toMatchObject({ status: 'scheduled', startsAt: s1!.startsAt, durationMin: 60, pollClosesAt: null, scheduledEventId: 'event1' });
    expect((await repos.listRsvps(meeting!.id)).map((r) => [r.userId, r.status]).sort()).toEqual([
      ['101', 'yes'],
      ['102', 'maybe'],
    ]);
    const jobs = await ctx.pool.query(`select kind::text from scheduled_jobs where meeting_id = '${meeting!.id}' and done_at is null`);
    expect(jobs.rows.map((r) => r.kind)).toContain('start');
    expect(jobs.rows.map((r) => r.kind)).not.toContain('poll_close');
    // Historique : la grille figée est publiée avant l'annonce, créneau retenu marqué, sans notifier.
    const results = threads[0]!.sent.at(-2)! as { embeds: Array<{ title: string; fields: Array<{ name: string; value: string }> }>; allowedMentions: unknown };
    expect(results.embeds[0]!.title).toContain('Résultat du sondage');
    expect(results.embeds[0]!.fields[0]!.name.startsWith('📅')).toBe(true);
    expect(results.embeds[0]!.fields[1]!.value).toContain('❌ <@101>');
    expect(results.allowedMentions).toEqual({ parse: [] });
    // Les réponses restent en base.
    expect(await repos.listVotes(meeting!.id)).toHaveLength(4);
    const announce = threads[0]!.sent.at(-1)!;
    expect(announce.content).toContain('est fixée');
    expect((announce.allowedMentions as { users: string[] }).users.sort()).toEqual(['101', '102', '103']);
    expect(threads[0]!.thread.setName).toHaveBeenCalled();
  });

  it('égalité à la clôture : l’organisateur est mentionné pour trancher, le sondage reste ouvert', async () => {
    const meeting = await service.createPoll(guild as never, 'organizer', { title: 'Bureau', description: '', voiceChannelId: 'v', slots: slotsInput, closesAt: new Date(Date.now() + 3_600_000) });
    const [s1, s2] = await repos.listSlots(meeting.id);
    await repos.setVote(s1!.id, '101', 'yes');
    await repos.setVote(s2!.id, '102', 'yes');
    await service.closePoll(meeting.id);
    expect((await repos.getMeeting(meeting.id))?.status).toBe('polling');
    const last = threads[1]!.sent.at(-1)!;
    expect(last.content).toContain('<@organizer>');
    expect(last.allowedMentions).toEqual({ users: ['organizer'] });

    // L'organisateur tranche : la date est fixée au créneau choisi.
    await service.fixDate(guild as never, meeting.id, s2!.id, 'organizer');
    expect(await repos.getMeeting(meeting.id)).toMatchObject({ status: 'scheduled', startsAt: s2!.startsAt, durationMin: 90 });
  });

  it('créneaux : ajout (sans doublon), retrait (jamais le dernier)', async () => {
    const meeting = await service.createPoll(guild as never, 'organizer', { title: 'Comité', description: '', voiceChannelId: 'v', slots: slotsInput, closesAt: new Date(Date.now() + 86_400_000) });
    const extra = { startsAt: new Date(Date.now() + 7 * 86_400_000), durationMin: 60 };
    await service.addSlot(meeting.id, extra);
    await expect(service.addSlot(meeting.id, extra)).rejects.toThrow('déjà proposé');
    const slots = await repos.listSlots(meeting.id);
    expect(slots).toHaveLength(3);
    await service.removeSlot(meeting.id, slots[0]!.id);
    await service.removeSlot(meeting.id, slots[1]!.id);
    await expect(service.removeSlot(meeting.id, slots[2]!.id)).rejects.toThrow('dernier créneau');
  });
});
