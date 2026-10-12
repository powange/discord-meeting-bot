import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { freshDatabase } from './helpers/db.js';
import { createDb, runMigrations, type Db } from '../src/db/client.js';
import { Repositories } from '../src/db/repositories.js';
import { PipelineService, type StepFn } from '../src/pipeline/runner.js';
import { createSteps } from '../src/pipeline/steps.js';
import { SegmentWriter } from '../src/recording/segmentWriter.js';
import { SettingsService } from '../src/services/settings.js';

/**
 * Bout en bout (sans Discord) : pistes OGG réelles → ffmpeg → backends de transcription
 * simulés (bascule) → LLM simulé → résumé en BDD. Plus la relance et la reprise du traitement.
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm test
 */
const url = process.env.TEST_DATABASE_URL;
const log = pino({ level: 'silent' });

describe.skipIf(!url)('Traitement post-réunion (PostgreSQL, ffmpeg, serveurs simulés)', () => {
  let db: Db;
  let pool: { end(): Promise<void> };
  let repos: Repositories;
  let server: Server;
  let base: string;
  let dataDir: string;
  const hits = { vibe: 0, speaches: 0, llm: 0 };
  const llmPrompts: string[] = [];

  beforeAll(async () => {
    ({ db, pool } = createDb(await freshDatabase(url!, 'pipeline')));
    await runMigrations(db);
    repos = new Repositories(db);
    dataDir = await mkdtemp(join(tmpdir(), 'mb-pipeline-'));

    server = createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      if (req.url === '/vibe/ready') return res.writeHead(200).end();
      if (req.url === '/vibe/v1/audio/transcriptions') {
        hits.vibe++;
        return res.writeHead(503).end('{"error":"gpu_out_of_memory"}'); // force la bascule
      }
      if (req.url === '/speaches/v1/models') return res.writeHead(200).end('{}');
      if (req.url === '/speaches/v1/audio/transcriptions') {
        hits.speaches++;
        const ok = raw.includes('RIFF'); // un vrai WAV a été envoyé
        return res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            model: 'large-v3',
            segments: [
              { start: 0.2, end: 1.0, text: ok ? ' Bonjour à tous.' : ' WAV ABSENT' },
              { start: 1.0, end: 1.5, text: " Sous-titres réalisés par la communauté d'Amara.org" },
            ],
          }),
        );
      }
      if (req.url === '/llm/v1/chat/completions') {
        hits.llm++;
        llmPrompts.push(JSON.parse(raw).messages.at(-1).content);
        return res
          .writeHead(200, { 'content-type': 'application/json', 'x-litellm-model-id': 'ollama-pc1' })
          .end(JSON.stringify({ model: 'qwen3', choices: [{ message: { content: '{"overview":"Salutations.","topics":[]}' } }] }));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool?.end();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function seedMeeting() {
    const meeting = await repos.insertMeeting({ guildId: 'g', organizerId: 'o', title: 'Bureau', startsAt: new Date('2026-10-15T16:00:00Z'), durationMin: 60, voiceChannelId: 'v' });
    const startedAt = new Date('2026-10-15T16:00:00Z');
    const rec = await repos.insertRecording({ meetingId: meeting.id, guildId: 'g', voiceChannelId: 'v', startedAt, dataDir });
    await repos.insertPresence({ recordingId: rec.id, userId: 'alice', displayName: 'Alice', joinedAt: startedAt });
    await repos.insertPresence({ recordingId: rec.id, userId: 'bob', displayName: 'Bob', joinedAt: startedAt });
    // alice : deux prises de parole proches (un seul bloc) ; bob : une prise de parole
    for (const [user, startMs, frames] of [['alice', 0, 50], ['alice', 2000, 50], ['bob', 10_000, 75]] as const) {
      const w = SegmentWriter.open(join(dataDir, rec.id, user, `${startMs}.ogg`));
      for (let i = 0; i < frames; i++) w.write(Buffer.from([0xf8, 0xff, 0xfe]), startMs + i * 20);
      const s = await w.close();
      await repos.insertSegment({ recordingId: rec.id, userId: user, startMs, endMs: startMs + frames * 20, packets: s.packets, filePath: s.filePath });
    }
    return meeting;
  }

  function deps() {
    const config = buildConfig(
      {
        discord: { token: 'x' },
        database: { url: url! },
        dataDir,
        defaults: {
          transcription: {
            backends: [
              { name: 'vibe-pc', type: 'vibe', url: `${base}/vibe` },
              { name: 'speaches', type: 'openai', url: `${base}/speaches/v1`, model: 'large-v3' },
            ],
          },
          llm: { baseUrl: `${base}/llm/v1`, model: 'summary' },
        },
      },
      {},
    );
    const client = { guilds: { fetch: async () => ({ premiumTier: 0 }) } } as unknown as Client;
    return { client, repos, settings: new SettingsService(repos, config), config, log };
  }

  it('transcription (bascule) puis résumé', async () => {
    const meeting = await seedMeeting();
    const d = deps();
    const steps = createSteps(d);
    const settings = await d.settings.get('g');
    const ctx = { meeting, settings, m: (await import('../src/i18n/index.js')).messages('fr'), signal: new AbortController().signal, log, progress: () => undefined };

    await steps.transcribe(ctx);
    const blocks = await repos.upsertBlocks(meeting.id, []);
    expect(blocks.map((b) => [b.userId, b.segmentIds.length, b.done, b.backend])).toEqual([
      ['alice', 2, true, 'speaches'],
      ['bob', 1, true, 'speaches'],
    ]);
    expect(hits.vibe).toBeGreaterThan(0); // tenté, en échec → bascule

    const transcript = await repos.listTranscript(meeting.id);
    expect(transcript.map((t) => [t.userId, t.text, t.startAt.toISOString()])).toEqual([
      ['alice', 'Bonjour à tous.', '2026-10-15T16:00:00.200Z'],
      ['bob', 'Bonjour à tous.', '2026-10-15T16:00:10.200Z'], // hallucination filtrée, temps absolus
    ]);

    // Idempotence : relancer ne retranscrit pas les blocs déjà faits.
    const before = hits.speaches;
    await steps.transcribe(ctx);
    expect(hits.speaches).toBe(before);

    await steps.summarize(ctx);
    const summary = await repos.getSummary(meeting.id);
    expect(summary).toMatchObject({ content: { overview: 'Salutations.' }, passes: 1, llmDeployments: ['qwen3 (ollama-pc1)'], transcriptionBackends: ['speaches (large-v3)'] });
    expect(llmPrompts.at(-1)).toContain('[18:00:00] Alice : Bonjour à tous.');
    expect(llmPrompts.at(-1)).toContain('Participants : Alice, Bob');
  }, 60_000);

  it('sans LLM configuré : résumé sauté, pas d’échec', async () => {
    const meeting = await seedMeeting();
    const d = deps();
    const noLlm = buildConfig({ discord: { token: 'x' }, database: { url: url! }, dataDir }, {});
    const steps = createSteps({ ...d, config: noLlm });
    const settings = await d.settings.get('g');
    const ctx = { meeting, settings, m: (await import('../src/i18n/index.js')).messages('fr'), signal: new AbortController().signal, log, progress: () => undefined };
    await repos.upsertBlocks(meeting.id, []); // pas de transcription nécessaire pour ce cas : on force une ligne
    const block = (await repos.upsertBlocks(meeting.id, [{ recordingId: (await repos.listRecordingsForMeeting(meeting.id))[0]!.id, userId: 'alice', startMs: 0, endMs: 1000, segmentIds: [] }]))[0]!;
    await repos.completeBlock(block.id, meeting.id, [{ userId: 'alice', startAt: new Date(), endAt: new Date(), text: 'Bonjour.' }], 'vibe-pc', 'm');
    expect(await steps.summarize(ctx)).toEqual({ skipped: true });
  }, 30_000);

  it('audio complet : toutes les prises de parole sur une même ligne de temps, en Opus', async () => {
    const meeting = await seedMeeting();
    const d = deps();
    const settings = await d.settings.get('g');
    const ctx = { meeting, settings, m: (await import('../src/i18n/index.js')).messages('fr'), signal: new AbortController().signal, log, progress: () => undefined };
    const out = await createSteps(d).mix(ctx);
    expect(out).toMatchObject({ durationMs: 11_500, bitrateKbps: 32 }); // bob finit à 10 s + 1,5 s
    const { ffmpegPath, runFfmpeg } = await import('../src/lib/ffmpeg.js');
    await runFfmpeg(ffmpegPath(), ['-v', 'error', '-i', out.file as string, '-f', 'null', '-']); // décodable sans erreur
    expect(out.sizeBytes as number).toBeGreaterThan(0);
  }, 60_000);

  it('arrêt d’enregistrement : mise à jour enchaînée si un traitement tourne ; clôture sans doublon', async () => {
    const meeting = await seedMeeting();
    const calls: string[] = [];
    let release!: () => void;
    let gate: Promise<void> | null = new Promise((r) => (release = r));
    const engine = new PipelineService(deps(), {
      mix: async () => {
        calls.push('mix');
        if (gate) {
          const g = gate;
          gate = null;
          await g; // le premier traitement reste bloqué ici
        }
        return {};
      },
      transcribe: async () => (calls.push('transcribe'), {}),
      summarize: async () => (calls.push('summarize'), {}),
      publish: async () => (calls.push('publish'), {}),
    });

    await engine.refresh(meeting.id); // 1er arrêt d'enregistrement
    await new Promise((r) => setTimeout(r, 50));
    await engine.refresh(meeting.id); // 2e arrêt pendant le traitement → mise à jour après
    release();
    await waitIdle(engine, meeting.id);
    expect(calls).toEqual(['mix', 'transcribe', 'summarize', 'publish', 'mix', 'transcribe', 'summarize', 'publish']);

    // Clôture de la réunion : tout est déjà traité → rien de plus.
    await repos.updateRecording((await repos.listRecordingsForMeeting(meeting.id))[0]!.id, { endedAt: new Date(Date.now() - 60_000) });
    await engine.processIfNeeded(meeting.id);
    await waitIdle(engine, meeting.id);
    expect(calls).toHaveLength(8);

    // Une session terminée après le dernier traitement (ex. interrompue) est rattrapée à la clôture.
    await repos.updateRecording((await repos.listRecordingsForMeeting(meeting.id))[0]!.id, { endedAt: new Date(Date.now() + 60_000) });
    await engine.processIfNeeded(meeting.id);
    await waitIdle(engine, meeting.id);
    expect(calls).toHaveLength(12);
  }, 30_000);

  it('moteur : échec → relance de l’étape seulement ; reprise après arrêt', async () => {
    const meeting = await seedMeeting();
    const calls: string[] = [];
    let failSummarize = true;
    const fake = (name: string, fail = () => false): StepFn => async () => {
      calls.push(name);
      if (fail()) throw new Error(`${name} KO`);
      return { ok: true };
    };
    const engine = new PipelineService(deps(), {
      mix: fake('mix'),
      transcribe: fake('transcribe'),
      summarize: fake('summarize', () => failSummarize),
      publish: fake('publish'),
    });

    await engine.schedule(meeting.id);
    await waitIdle(engine, meeting.id);
    expect(calls).toEqual(['mix', 'transcribe', 'summarize']);
    expect((await repos.listPipeline(meeting.id)).map((r) => [r.step, r.status, r.error])).toEqual([
      ['mix', 'done', null],
      ['transcribe', 'done', null],
      ['summarize', 'failed', 'summarize KO'],
      ['publish', 'pending', null],
    ]);

    failSummarize = false;
    await engine.retry(meeting.id);
    await waitIdle(engine, meeting.id);
    expect(calls).toEqual(['mix', 'transcribe', 'summarize', 'summarize', 'publish']);
    expect((await repos.listPipeline(meeting.id)).every((r) => r.status === 'done')).toBe(true);

    // Reprise : une étape restée « en cours » (arrêt brutal) est refaite au démarrage.
    await repos.updateStep(meeting.id, 'publish', { status: 'running' });
    expect(await repos.listUnfinishedPipelines()).toContain(meeting.id);
    await engine.resume();
    await waitIdle(engine, meeting.id);
    expect(calls.at(-1)).toBe('publish');
    expect(await repos.listUnfinishedPipelines()).not.toContain(meeting.id);
  }, 30_000);
});

async function waitIdle(engine: PipelineService, meetingId: string): Promise<void> {
  for (let i = 0; i < 200 && engine.isQueued(meetingId); i++) await new Promise((r) => setTimeout(r, 25));
}
