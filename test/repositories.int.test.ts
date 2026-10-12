import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDatabase } from './helpers/db.js';
import { createDb, runMigrations, type Db } from '../src/db/client.js';
import { Repositories } from '../src/db/repositories.js';
import { planJobs } from '../src/domain/reminders.js';

/**
 * Tests d'intégration sur un vrai PostgreSQL (ignorés sans TEST_DATABASE_URL) :
 *   docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=test postgres:17
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm test
 */
const url = process.env.TEST_DATABASE_URL;
const seed = { timezone: 'Europe/Paris', locale: 'fr' as const, reminderOffsetsMin: [1440, 15], defaultDurationMin: 60, autoRecordDefault: false };

describe.skipIf(!url)('Repositories (PostgreSQL)', () => {
  let db: Db;
  let pool: { end(): Promise<void> };
  let repos: Repositories;

  beforeAll(async () => {
    ({ db, pool } = createDb(await freshDatabase(url!, 'repos')));
    await runMigrations(db);
    repos = new Repositories(db);
  });
  afterAll(async () => pool?.end());

  const newMeeting = (startsAt = new Date(Date.now() + 3 * 86_400_000)) =>
    repos.insertMeeting({ guildId: 'g', organizerId: 'o', title: 'T', startsAt, durationMin: 60, voiceChannelId: 'v' });

  it('crée les réglages à partir du seed une seule fois', async () => {
    const s1 = await repos.getSettings('g', seed);
    await repos.updateSettings('g', { timezone: 'Europe/Brussels' });
    const s2 = await repos.getSettings('g', seed);
    expect(s1.reminderOffsetsMin).toEqual([1440, 15]);
    expect(s2.timezone).toBe('Europe/Brussels');
  });

  it('transition conditionnelle', async () => {
    const m = await newMeeting();
    expect(await repos.transitionMeeting(m.id, ['scheduled'], 'live')).toMatchObject({ status: 'live' });
    expect(await repos.transitionMeeting(m.id, ['scheduled'], 'live')).toBeUndefined();
  });

  it('RSVP : upsert', async () => {
    const m = await newMeeting();
    await repos.setRsvp(m.id, 'u', 'yes');
    await repos.setRsvp(m.id, 'u', 'no');
    expect((await repos.listRsvps(m.id)).map((r) => r.status)).toEqual(['no']);
  });

  it('ODJ : ajouts concurrents, réordonnancement, retrait', async () => {
    const m = await newMeeting();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => repos.addAgendaItem(m.id, 'a', () => ({ title: `P${i}`, detail: '' }))),
    );
    let items = await repos.listAgenda(m.id);
    expect(items.map((i) => i.position)).toEqual([0, 1, 2, 3, 4]);
    const ids = items.map((i) => i.id);
    await repos.reorderAgenda(m.id, [ids[4]!, ids[0]!, ids[2]!]); // retire ids[1] et ids[3]
    items = await repos.listAgenda(m.id);
    expect(items.map((i) => [i.id, i.position])).toEqual([
      [ids[4], 0],
      [ids[0], 1],
      [ids[2], 2],
    ]);
    await expect(
      repos.addAgendaItem(m.id, 'a', (count) => {
        if (count >= 3) throw new Error('plein');
        return { title: 'x', detail: '' };
      }),
    ).rejects.toThrow('plein');
  });

  it('échéances : réservation, exécution, replanification', async () => {
    const startsAt = new Date(Date.now() + 10 * 60_000);
    const m = await newMeeting(startsAt);
    const now = new Date();
    await repos.replaceJobs(m.id, planJobs({ startsAt, durationMin: 60, status: 'scheduled' }, [1440, 5], now));

    // Rien n'est dû maintenant ; dans 6 minutes, seul le rappel à 5 min l'est.
    expect((await repos.claimDueJobs(now, 10, 5)).filter((j) => j.meetingId === m.id)).toHaveLength(0);
    const later = new Date(now.getTime() + 6 * 60_000);
    const claimed = (await repos.claimDueJobs(later, 10, 5)).filter((j) => j.meetingId === m.id);
    expect(claimed.map((j) => [j.kind, j.offsetMin, j.attempts])).toEqual([['reminder', 5, 1]]);
    // Réservé : un second tick ne le reprend pas.
    expect((await repos.claimDueJobs(later, 10, 5)).filter((j) => j.meetingId === m.id)).toHaveLength(0);
    await repos.completeJob(claimed[0]!.id);

    // Replanification (réunion décalée d'un jour) : le rappel déjà envoyé est réarmé.
    const moved = new Date(startsAt.getTime() + 86_400_000);
    await repos.replaceJobs(m.id, planJobs({ startsAt: moved, durationMin: 60, status: 'scheduled' }, [5], now));
    const inADay = new Date(moved.getTime() - 4 * 60_000);
    const again = (await repos.claimDueJobs(inADay, 10, 5)).filter((j) => j.meetingId === m.id);
    expect(again.map((j) => j.kind)).toEqual(['reminder']);
  });

  it("replanifier pendant l'exécution conserve l'échéance en cours", async () => {
    const m = await newMeeting(new Date(Date.now() + 60_000));
    await repos.replaceJobs(m.id, [{ kind: 'start', offsetMin: 0, dueAt: new Date(Date.now() - 1000) }]);
    const [job] = (await repos.claimDueJobs(new Date(), 10, 5)).filter((j) => j.meetingId === m.id);
    // Le passage « En cours » replanifie (ici : une échéance quelconque à venir).
    await repos.replaceJobs(m.id, [{ kind: 'auto_end', offsetMin: 0, dueAt: new Date(Date.now() + 3_600_000) }]);
    await repos.completeJob(job!.id);
    const rows = await db.execute<{ kind: string; done: boolean }>(
      `select kind, done_at is not null as done from scheduled_jobs where meeting_id = '${m.id}' order by kind`,
    );
    // Tri par ordre de déclaration de l'enum : reminder, start, auto_end.
    expect(rows.rows).toEqual([
      { kind: 'start', done: true },
      { kind: 'auto_end', done: false },
    ]);
  });

  it('échec : backoff puis nouvelle tentative', async () => {
    const m = await newMeeting(new Date(Date.now() + 60_000));
    await repos.replaceJobs(m.id, [{ kind: 'start', offsetMin: 0, dueAt: new Date(Date.now() - 1000) }]);
    const now = new Date();
    const [job] = (await repos.claimDueJobs(now, 10, 5)).filter((j) => j.meetingId === m.id);
    await repos.failJob(job!, 'boom', now);
    expect((await repos.claimDueJobs(new Date(now.getTime() + 30_000), 10, 5)).filter((j) => j.meetingId === m.id)).toHaveLength(0);
    const retried = (await repos.claimDueJobs(new Date(now.getTime() + 61_000), 10, 5)).filter((j) => j.meetingId === m.id);
    expect(retried.map((j) => [j.attempts, j.lastError])).toEqual([[2, 'boom']]);
  });

  it('enregistrement : session active, présences, segments', async () => {
    const m = await newMeeting();
    const t0 = new Date('2026-10-15T16:00:00Z');
    const rec = await repos.insertRecording({ meetingId: m.id, guildId: 'g', voiceChannelId: 'v', startedAt: t0, dataDir: '/data/x' });
    expect((await repos.getActiveRecording(m.id))?.id).toBe(rec.id);

    await repos.insertPresence({ recordingId: rec.id, userId: 'a', displayName: 'A', joinedAt: t0 });
    await repos.insertPresence({ recordingId: rec.id, userId: 'b', displayName: 'B', joinedAt: t0, excluded: true });
    await repos.closePresence(rec.id, new Date('2026-10-15T16:10:00Z'), 'a');
    await repos.closePresence(rec.id, new Date('2026-10-15T16:30:00Z'));
    const presence = await repos.listPresence(rec.id);
    expect(presence.map((p) => [p.userId, p.leftAt?.toISOString(), p.excluded])).toEqual([
      ['a', '2026-10-15T16:10:00.000Z', false],
      ['b', '2026-10-15T16:30:00.000Z', true],
    ]);

    await repos.insertSegment({ recordingId: rec.id, userId: 'a', startMs: 5000, endMs: 7000, packets: 100, filePath: '/x/a/2.ogg' });
    await repos.insertSegment({ recordingId: rec.id, userId: 'a', startMs: 1000, endMs: 2000, packets: 50, filePath: '/x/a/1.ogg' });
    expect((await repos.listSegments(rec.id)).map((s) => s.startMs)).toEqual([1000, 5000]);

    await repos.updateRecording(rec.id, { status: 'stopped', endedAt: new Date() });
    expect(await repos.getActiveRecording(m.id)).toBeUndefined();
  });

  it('suppression en cascade', async () => {
    const m = await newMeeting();
    await repos.setRsvp(m.id, 'u', 'yes');
    await repos.deleteMeeting(m.id);
    expect(await repos.listRsvps(m.id)).toEqual([]);
  });
});
