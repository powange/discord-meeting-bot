import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { createDb, runMigrations, type Db } from '../src/db/client.js';
import { Repositories } from '../src/db/repositories.js';
import { RetentionService } from '../src/services/retention.js';
import { freshDatabase } from './helpers/db.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Rétention (PostgreSQL + fichiers)', () => {
  let db: Db;
  let pool: { end(): Promise<void> };
  let repos: Repositories;
  let dir: string;

  beforeAll(async () => {
    ({ db, pool } = createDb(await freshDatabase(url!, 'retention')));
    await runMigrations(db);
    repos = new Repositories(db);
    dir = await mkdtemp(join(tmpdir(), 'mb-retention-'));
  });
  afterAll(async () => {
    await pool?.end();
    await rm(dir, { recursive: true, force: true });
  });

  const now = new Date('2026-12-01T00:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  async function seed(name: string, opts: { status: 'ended' | 'live'; endedDaysAgo: number; stepsDone: boolean }) {
    const meeting = await repos.insertMeeting({ guildId: 'g', organizerId: 'o', title: name, startsAt: daysAgo(opts.endedDaysAgo), durationMin: 60, voiceChannelId: 'v' });
    await repos.updateMeeting(meeting.id, { status: opts.status });
    const recDir = join(dir, name, 'rec');
    await mkdir(recDir, { recursive: true });
    await writeFile(join(recDir, 'seg.ogg'), 'x');
    const rec = await repos.insertRecording({ meetingId: meeting.id, guildId: 'g', voiceChannelId: 'v', startedAt: daysAgo(opts.endedDaysAgo), endedAt: daysAgo(opts.endedDaysAgo), dataDir: recDir, status: 'stopped' });
    await repos.insertSegment({ recordingId: rec.id, userId: 'u', startMs: 0, endMs: 1000, packets: 50, filePath: join(recDir, 'seg.ogg') });
    const mixFile = join(dir, name, 'mix.ogg');
    await writeFile(mixFile, 'x');
    await repos.ensurePipeline(meeting.id);
    if (opts.stepsDone) {
      await repos.updateStep(meeting.id, 'mix', { status: 'done', finishedAt: daysAgo(opts.endedDaysAgo), output: { file: mixFile } });
      await repos.updateStep(meeting.id, 'transcribe', { status: 'done' });
    }
    return { meeting, rec, recDir, mixFile };
  }

  it('purge les pistes et l’audio anciens d’une réunion traitée, rien d’autre', async () => {
    const old = await seed('ancienne', { status: 'ended', endedDaysAgo: 400, stepsDone: true });
    const recent = await seed('recente', { status: 'ended', endedDaysAgo: 5, stepsDone: true });
    const open = await seed('ouverte', { status: 'live', endedDaysAgo: 400, stepsDone: true });
    const failed = await seed('echec', { status: 'ended', endedDaysAgo: 400, stepsDone: false });

    const config = buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' }, dataDir: dir }, {});
    const report = await new RetentionService(repos, config, pino({ level: 'silent' })).purge(now);
    expect(report).toEqual({ rawRecordings: 1, mixes: 2 }); // l'audio complet de « ouverte » a 400 j : purgé aussi (copie locale)

    expect(existsSync(old.recDir)).toBe(false);
    expect(existsSync(old.mixFile)).toBe(false);
    expect((await repos.getRecording(old.rec.id))?.purgedAt).toEqual(now);
    expect((await repos.listPipeline(old.meeting.id)).find((s) => s.step === 'mix')?.output).toMatchObject({ purgedAt: now.toISOString() });

    for (const kept of [recent, open, failed]) expect(existsSync(kept.recDir)).toBe(true);
    expect(existsSync(recent.mixFile)).toBe(true);

    // Idempotent : une seconde purge ne fait rien.
    expect(await new RetentionService(repos, config, pino({ level: 'silent' })).purge(now)).toEqual({ rawRecordings: 0, mixes: 0 });
  });
});
