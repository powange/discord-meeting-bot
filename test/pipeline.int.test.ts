import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
import { pipelineSteps } from '../src/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { Repositories } from '../src/db/repositories.js';
import { PipelineService, type StepFn } from '../src/pipeline/runner.js';
import { createSteps } from '../src/pipeline/steps.js';
import { StorageService } from '../src/services/storage.js';
import { fakeThread } from './helpers/discordFakes.js';
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
  let llmContextRefusals = 0;

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
        // Contexte trop petit simulé : refus tant que des « refus » restent à servir.
        if (llmContextRefusals > 0) {
          llmContextRefusals--;
          return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"code":400,"message":"request (9908 tokens) exceeds the available context size (8192 tokens)"}}');
        }
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

    // Note prise en direct entre les deux répliques : transmise au résumé à sa place.
    await repos.addMarker({ meetingId: meeting.id, kind: 'decision', at: new Date('2026-10-15T16:00:05Z'), text: 'Budget adopté', authorId: 'alice' });
    await steps.summarize(ctx);
    expect(llmPrompts.at(-1)).toContain('[18:00:00] Alice : Bonjour à tous.\n[18:00:05] 📝 Décision notée en direct : Budget adopté\n[18:00:10] Bob');
    const summary = await repos.getSummary(meeting.id);
    expect(summary).toMatchObject({ content: { overview: 'Salutations.' }, passes: 1, llmDeployments: ['qwen3 (ollama-pc1)'], transcriptionBackends: ['speaches (large-v3)'] });
    expect(llmPrompts.at(-1)).toContain('[18:00:00] Alice : Bonjour à tous.');
    expect(llmPrompts.at(-1)).toContain('Participants : Alice, Bob');
  }, 60_000);

  it('résumé refusé pour contexte trop petit : recommencé avec des morceaux plus petits', async () => {
    const meeting = await seedMeeting();
    const d = deps();
    const steps = createSteps(d);
    const settings = await d.settings.get('g');
    const progress: string[] = [];
    const ctx = { meeting, settings, m: (await import('../src/i18n/index.js')).messages('fr'), signal: new AbortController().signal, log, progress: (x: string) => void progress.push(x) };
    await steps.transcribe(ctx);
    llmContextRefusals = 1;
    const before = hits.llm;
    expect(await steps.summarize(ctx)).toMatchObject({ passes: 1 });
    expect(hits.llm - before).toBe(2); // refus, puis nouvel essai réussi
    expect(progress.some((x) => x.includes('morceaux de 3000 tokens'))).toBe(true);
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

  it('publication : éditée sur place à la régénération, nouveaux responsables seuls mentionnés, republiée si un message manque', async () => {
    const meeting = await repos.updateMeeting((await seedMeeting()).id, { threadId: 'thread-pub' });
    const rec = (await repos.listRecordingsForMeeting(meeting!.id))[0]!;
    await repos.insertPresence({ recordingId: rec.id, userId: '555', displayName: 'Carole', joinedAt: new Date('2026-10-15T16:00:00Z') });
    await repos.insertPresence({ recordingId: rec.id, userId: '556', displayName: 'Dan', joinedAt: new Date('2026-10-15T16:00:00Z') });
    const { thread, sent, edited, deleted } = fakeThread('thread-pub');
    const d = { ...deps(), client: { guilds: { fetch: async () => ({ premiumTier: 0 }) }, channels: { fetch: async () => thread } } as unknown as Client };
    const steps = createSteps(d);
    const settings = await d.settings.get('g');
    const ctx = { meeting: meeting!, settings, m: (await import('../src/i18n/index.js')).messages('fr'), signal: new AbortController().signal, log, progress: () => undefined };
    await steps.transcribe(ctx);
    await repos.ensurePipeline(meeting!.id);
    const summary = (who: string[]) => ({
      overview: 'Synthèse.',
      topics: [{ agendaItemId: null, title: 'Budget', summary: 'Discuté.', decisions: [], actions: who.map((w) => ({ what: 'Faire', who: w, when: null })), openQuestions: [] }],
    });
    const publish = async () => {
      const output = await steps.publish(ctx);
      await repos.updateStep(meeting!.id, 'publish', { status: 'done', output });
      return output;
    };
    const save = (who: string[]) => repos.saveSummary({ meetingId: meeting!.id, content: summary(who), llmModel: 'm', llmDeployments: [], transcriptionBackends: [], passes: 1 });

    // 1re publication : Carole est mentionnée.
    await save(['Carole']);
    const first = await publish();
    expect(sent.map((p) => (p.allowedMentions as { users: string[] }).users)).toEqual(sent.map(() => ['555']));
    // Dernier message : le compte rendu en PDF (téléchargeable) et la transcription.
    const files = (sent.at(-1)!.files as Array<{ name: string; attachment: Buffer }>).map((f) => [f.name, f.attachment.subarray(0, 5).toString()]);
    expect(files).toEqual([
      ['compte-rendu-2026-10-15.pdf', '%PDF-'],
      ['transcription-2026-10-15.md', '# Tra'],
    ]);
    const count = sent.length;

    // Correction sans nouveau responsable : édition sur place, aucun message envoyé ni supprimé.
    expect(await publish()).toMatchObject({ messageIds: first.messageIds });
    expect(sent).toHaveLength(count);
    expect(deleted).toEqual([]);
    expect(edited.length).toBe(count);

    // Nouveau responsable : republication, seul Dan est mentionné, l'ancien compte rendu supprimé ensuite.
    await save(['Carole', 'Dan']);
    const third = await publish();
    expect(sent.slice(count).map((p) => (p.allowedMentions as { users: string[] }).users)).toEqual(sent.slice(count).map(() => ['556']));
    expect(deleted).toEqual(first.messageIds);

    // Message supprimé à la main : republication (pas d'édition impossible).
    await thread.messages.delete((third.messageIds as string[])[0]!);
    const before = sent.length;
    await publish();
    expect(sent.length).toBeGreaterThan(before);
    // Pipeline laissé terminé : les autres tests de ce fichier partagent la base.
    for (const step of ['mix', 'transcribe', 'summarize'] as const) await repos.updateStep(meeting!.id, step, { status: 'done' });
  }, 60_000);

  it('copie vers le stockage : compte rendu, transcription et audio dans un dossier par réunion ; rien sans stockage', async () => {
    const meeting = await seedMeeting();
    const d = deps();
    const settings = await d.settings.get('g');
    const ctx = { meeting, settings, m: (await import('../src/i18n/index.js')).messages('fr'), signal: new AbortController().signal, log, progress: () => undefined };
    expect(await createSteps(d).export(ctx)).toEqual({ skipped: true }); // pas de StorageService
    const uploads: Array<{ path: string; name: string; size: number; text: string }> = [];
    const storage = new StorageService(repos, d.config, log, () => ({
      account: async () => 'asso@gmail.com',
      root: async (name) => ({ id: name }),
      folder: async (parent, name) => `${parent}/${name}`,
      put: async (folder, name, source) => {
        const data = 'data' in source ? source.data : await readFile(source.path);
        uploads.push({ path: folder, name, size: data.length, text: name.endsWith('.md') ? data.toString('utf8') : '' });
      },
    }));
    const steps = createSteps({ ...d, storage });
    expect(await steps.export(ctx)).toEqual({ skipped: true }); // serveur sans stockage connecté

    await steps.transcribe(ctx);
    await steps.summarize(ctx);
    await repos.ensurePipeline(meeting.id);
    await repos.updateStep(meeting.id, 'summarize', { status: 'done', output: {} });
    await repos.updateStep(meeting.id, 'mix', { status: 'done', output: await steps.mix(ctx) });
    await repos.setStorage({ guildId: 'g', provider: 'google', credentials: JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }), account: 'asso@gmail.com', connectedBy: 'o' });
    await storage.setFolder('g', 'Asso');

    const out = await steps.export(ctx);
    expect(out).toEqual({
      provider: 'google',
      path: 'Asso/2026-10-15 18h00 - Bureau',
      files: ['compte-rendu-2026-10-15.md', 'compte-rendu-2026-10-15.pdf', 'transcription-2026-10-15.md', 'reunion-2026-10-15-18h00.ogg'],
    });
    expect(uploads.map((u) => u.path)).toEqual(Array(4).fill('Asso/2026-10-15 18h00 - Bureau'));
    expect(uploads[0]!.text).toContain('Salutations.');
    expect(uploads[1]!.size).toBeGreaterThan(1000); // PDF
    expect(uploads[2]!.text).toContain('**[18:00:00] Alice** : Bonjour à tous.');
    expect(uploads[3]!.size).toBeGreaterThan(0);
    expect((await repos.getStorage('g'))?.lastOkAt).toBeInstanceOf(Date);
    // Réunion à 1 h 30 du matin (heure de Paris) : fichiers datés du jour même, pas de la veille (UTC).
    const night = { ...ctx, meeting: { ...meeting, startsAt: new Date('2026-10-15T23:30:00Z') } };
    expect(await steps.export(night)).toMatchObject({ path: 'Asso/2026-10-16 01h30 - Bureau', files: ['compte-rendu-2026-10-16.md', 'compte-rendu-2026-10-16.pdf', 'transcription-2026-10-16.md', 'reunion-2026-10-15-18h00.ogg'] });
    await repos.removeStorage('g');
    // Étapes terminées : pas de reprise de cette réunion dans les tests suivants.
    for (const row of await repos.listPipeline(meeting.id)) await repos.updateStep(meeting.id, row.step, { status: 'done' });
  }, 60_000);

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

  it('audio complet incrémental : une nouvelle session s’ajoute au mix sans perte existant', async () => {
    const meeting = await seedMeeting();
    const d = deps();
    const settings = await d.settings.get('g');
    const ctx = { meeting, settings, m: (await import('../src/i18n/index.js')).messages('fr'), signal: new AbortController().signal, log, progress: () => undefined };
    const steps = createSteps(d);
    await repos.ensurePipeline(meeting.id);
    const first = await steps.mix(ctx);
    expect(first).toMatchObject({ incremental: false, durationMs: 11_500 });
    await repos.updateStep(meeting.id, 'mix', { status: 'done', output: first });

    // Seconde session, 60 s après le début de la première (reprise après une coupure).
    const startedAt = new Date('2026-10-15T16:01:00Z');
    const rec = await repos.insertRecording({ meetingId: meeting.id, guildId: 'g', voiceChannelId: 'v', startedAt, dataDir });
    const w = SegmentWriter.open(join(dataDir, rec.id, 'alice', '0.ogg'));
    for (let i = 0; i < 100; i++) w.write(Buffer.from([0xf8, 0xff, 0xfe]), i * 20);
    const seg = await w.close();
    await repos.insertSegment({ recordingId: rec.id, userId: 'alice', startMs: 0, endMs: 2000, packets: seg.packets, filePath: seg.filePath });

    const second = await steps.mix(ctx);
    expect(second).toMatchObject({ incremental: true, durationMs: 62_000 });
    const { execFile } = await import('node:child_process');
    const { ffmpegPath } = await import('../src/lib/ffmpeg.js');
    const seconds = (file: string) =>
      new Promise<number>((resolve, reject) =>
        execFile(ffmpegPath(), ['-i', file, '-f', 'null', '-'], (err, _out, stderr) => {
          const times = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
          const last = times.at(-1);
          if (!last) return reject(err ?? new Error(stderr));
          resolve(Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]));
        }),
      );
    // Le nouveau mix contient l'ancien (0 à 11,5 s), le silence, puis la seconde session (60 à 62 s).
    expect(await seconds(second.master as string)).toBeCloseTo(62, 0);
    expect(await seconds(second.file as string)).toBeCloseTo(62, 0);

    // Rien de nouveau : mix complet (pas d'incrémental sans session ajoutée).
    await repos.updateStep(meeting.id, 'mix', { status: 'done', output: second });
    expect(await steps.mix(ctx)).toMatchObject({ incremental: false, durationMs: 62_000 });
    for (const step of ['transcribe', 'summarize', 'publish'] as const) await repos.updateStep(meeting.id, step, { status: 'done' });
  }, 60_000);

  it('réunion close : le mix sans perte est supprimé une fois le compte rendu publié', async () => {
    const meeting = await seedMeeting();
    await repos.updateMeeting(meeting.id, { status: 'ended' });
    const master = join(dataDir, `master-${meeting.id}.flac`);
    const { writeFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    await writeFile(master, 'x');
    const quick: StepFn = async () => ({});
    const engine = new PipelineService(deps(), { mix: async () => ({ master, file: 'x.ogg' }), transcribe: quick, summarize: quick, publish: quick, export: quick });
    await engine.schedule(meeting.id);
    await waitIdle(engine, meeting.id);
    expect(existsSync(master)).toBe(false);
    expect((await repos.listPipeline(meeting.id)).find((r) => r.step === 'mix')?.output).toMatchObject({ master: null, file: 'x.ogg' });
  }, 30_000);

  it('post supprimé à la main : l’arrêt de l’enregistrement ne lance pas de compte rendu', async () => {
    const meeting = await seedMeeting(); // threadId vidé (post supprimé)
    const calls: string[] = [];
    const quick: StepFn = async (ctx) => (ctx.meeting.id === meeting.id && calls.push(ctx.meeting.id), {});
    const engine = new PipelineService(deps(), { mix: quick, transcribe: quick, summarize: quick, publish: quick, export: quick });
    await engine.refresh(meeting.id);
    await engine.processIfNeeded(meeting.id);
    expect(engine.isQueued(meeting.id)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('arrêt d’enregistrement : mise à jour enchaînée si un traitement tourne ; clôture sans doublon', async () => {
    const meeting = (await repos.updateMeeting((await seedMeeting()).id, { threadId: 'thread-refresh' }))!; // un post où publier (sinon rien n'est traité)
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
      export: async () => ({}),
    });

    await engine.refresh(meeting.id); // 1er arrêt d'enregistrement
    // Attendre que le premier traitement soit vraiment commencé (pas un délai fixe : sous charge, il peut tarder).
    for (let i = 0; i < 200 && !calls.includes('mix'); i++) await new Promise((r) => setTimeout(r, 10));
    await engine.refresh(meeting.id); // 2e arrêt pendant le traitement → mise à jour après
    release();
    await waitIdle(engine, meeting.id);
    // Le traitement obsolète s'arrête après l'audio et la transcription (pas de résumé ni de
    // publication intermédiaires), puis la mise à jour refait tout.
    expect([...calls].sort()).toEqual(['mix', 'mix', 'publish', 'summarize', 'transcribe', 'transcribe']);
    expect(calls.slice(-2)).toEqual(['summarize', 'publish']);

    // Clôture de la réunion : tout est déjà traité → rien de plus.
    await repos.updateRecording((await repos.listRecordingsForMeeting(meeting.id))[0]!.id, { endedAt: new Date(Date.now() - 60_000) });
    await engine.processIfNeeded(meeting.id);
    await waitIdle(engine, meeting.id);
    expect(calls).toHaveLength(6);

    // Une session terminée après le dernier traitement (ex. interrompue) est rattrapée à la clôture.
    await repos.updateRecording((await repos.listRecordingsForMeeting(meeting.id))[0]!.id, { endedAt: new Date(Date.now() + 60_000) });
    await engine.processIfNeeded(meeting.id);
    await waitIdle(engine, meeting.id);
    expect(calls).toHaveLength(10);
  }, 30_000);

  it('file par serveur : serveurs servis à tour de rôle, plafond global, jamais deux réunions d’un même serveur à la fois', async () => {
    const meetingIn = (guildId: string) =>
      repos.insertMeeting({ guildId, organizerId: 'o', title: guildId, startsAt: new Date('2026-10-15T16:00:00Z'), durationMin: 60, voiceChannelId: 'v' });
    const [a1, a2, b1] = [await meetingIn('ga'), await meetingIn('ga'), await meetingIn('gb')];
    const order: string[] = [];
    let concurrent = 0;
    let maxSeen = 0;
    const sameGuildTogether: string[] = [];
    const active = new Set<string>();
    const step: StepFn = async (ctx) => {
      if (ctx.meeting.guildId && [...active].some((id) => id !== ctx.meeting.id && id.startsWith(`${ctx.meeting.guildId}:`))) sameGuildTogether.push(ctx.meeting.id);
      active.add(`${ctx.meeting.guildId}:${ctx.meeting.id}`);
      concurrent++;
      maxSeen = Math.max(maxSeen, concurrent);
      order.push(ctx.meeting.id);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      active.delete(`${ctx.meeting.guildId}:${ctx.meeting.id}`);
      return {};
    };
    const quick: StepFn = async () => ({});
    const steps = { mix: step, transcribe: quick, summarize: quick, publish: quick, export: quick };

    // Un seul traitement à la fois : ga, ga, gb arrivés dans cet ordre → ga, gb, ga.
    const one = new PipelineService(deps(), steps);
    for (const m of [a1, a2, b1]) await one.schedule(m.id);
    for (const m of [a1, a2, b1]) await waitIdle(one, m.id);
    expect(order).toEqual([a1.id, b1.id, a2.id]);
    expect(maxSeen).toBe(1);

    // Deux à la fois : les deux serveurs en parallèle, mais jamais deux réunions de ga ensemble.
    order.length = 0;
    maxSeen = 0;
    const d = deps();
    const two = new PipelineService({ ...d, config: { ...d.config, pipeline: { maxConcurrent: 2 } } }, steps);
    for (const m of [a1, a2, b1]) await repos.resetSteps(m.id, ['mix', 'transcribe', 'summarize', 'publish']);
    for (const m of [a1, a2, b1]) await two.schedule(m.id);
    for (const m of [a1, a2, b1]) await waitIdle(two, m.id);
    expect(maxSeen).toBe(2);
    expect(sameGuildTogether).toEqual([]);
    expect(order).toHaveLength(3);
  }, 30_000);

  it('régénération demandée : la personne est prévenue à la publication, ou avec l’organisateur en cas d’échec', async () => {
    const meeting = (await repos.updateMeeting((await seedMeeting()).id, { threadId: 'thread-regen', organizerId: '900' }))!;
    const { thread, sent } = fakeThread('thread-regen');
    const d = { ...deps(), client: { guilds: { fetch: async () => ({ premiumTier: 0 }) }, channels: { fetch: async () => thread } } as unknown as Client };
    let fail = true;
    const quick: StepFn = async () => ({});
    const engine = new PipelineService(d, {
      mix: quick,
      transcribe: quick,
      summarize: async () => {
        if (fail) throw new Error('LLM : erreur 404 model "qwen3" not found') // définitif : pas de relance automatique;
        return {};
      },
      publish: async () => ({ url: 'https://discord.com/channels/g/thread-regen/42' }),
      export: async () => ({ skipped: true }),
    });
    const textOf = () => sent.filter((p) => typeof p.content === 'string').map((p) => [p.content as string, (p.allowedMentions as { users?: string[] })?.users]);

    // Échec : l'organisateur et le demandeur sont mentionnés, le demandeur reste à prévenir.
    await engine.regenerate(meeting.id, false, '555');
    await waitIdle(engine, meeting.id);
    expect(textOf().at(-1)).toEqual([expect.stringContaining("n'a pas pu être terminé"), ['900', '555']]);

    // Relance réussie : seul le demandeur est prévenu, avec le lien ; puis la liste est vidée.
    fail = false;
    await engine.regenerate(meeting.id, false, '555');
    await waitIdle(engine, meeting.id);
    expect(textOf().at(-1)).toEqual([expect.stringContaining('à jour : https://discord.com/channels/g/thread-regen/42'), ['555']]);
    expect((await repos.getMeeting(meeting.id))?.reportRequesters).toEqual([]);

    // Régénération sans demandeur (traitement automatique) : pas d'avis.
    const before = sent.length;
    await engine.regenerate(meeting.id, false);
    await waitIdle(engine, meeting.id);
    expect(sent.filter((p) => typeof p.content === 'string')).toHaveLength(textOf().length);
    expect(sent.slice(before).filter((p) => typeof p.content === 'string' && (p.content as string).includes('à jour'))).toEqual([]);
  }, 30_000);

  it('copie vers le stockage en échec : compte rendu annoncé quand même, organisateur pas dérangé, alerte aux admins', async () => {
    const meeting = (await repos.updateMeeting((await seedMeeting()).id, { threadId: 'thread-exp', organizerId: '900' }))!;
    const { thread, sent } = fakeThread('thread-exp');
    const alerts: string[] = [];
    const d = {
      ...deps(),
      client: { guilds: { fetch: async () => ({ premiumTier: 0 }) }, channels: { fetch: async () => thread } } as unknown as Client,
      alerts: { guild: async (_g: string, cause: string) => void alerts.push(cause) },
    };
    const quick: StepFn = async () => ({});
    const engine = new PipelineService(d, {
      mix: quick,
      transcribe: quick,
      summarize: quick,
      publish: async () => ({ url: 'https://discord.com/channels/g/thread-exp/1' }),
      export: async () => {
        throw new Error('HTTP 403 storageQuotaExceeded');
      },
    });
    const published: string[] = [];
    engine.setOnPublished((m) => published.push(m.id));
    await engine.regenerate(meeting.id, false, '555');
    await waitIdle(engine, meeting.id);
    expect(published).toEqual([meeting.id]);
    const texts = sent.filter((p) => typeof p.content === 'string').map((p) => p.content as string);
    expect(texts.some((t) => t.includes('à jour : https://discord.com/channels/g/thread-exp/1'))).toBe(true);
    expect(texts.some((t) => t.includes("n'a pas pu être terminé"))).toBe(false);
    expect(alerts).toEqual(['pipeline:export']);
    expect((await repos.listPipeline(meeting.id)).find((r) => r.step === 'export')?.status).toBe('failed');
    await repos.updateStep(meeting.id, 'export', { status: 'done' }); // pas de reprise dans les tests suivants
  }, 30_000);

  it('correction ou régénération : le nouveau compte rendu est aussi recopié vers le stockage, même pour une réunion d’avant le stockage', async () => {
    const meeting = await seedMeeting();
    const calls: string[] = [];
    const fake = (name: string): StepFn => async (ctx) => {
      if (ctx.meeting.id === meeting.id) calls.push(name);
      return {};
    };
    const engine = new PipelineService(deps(), { mix: fake('mix'), transcribe: fake('transcribe'), summarize: fake('summarize'), publish: fake('publish'), export: fake('export') });
    await engine.schedule(meeting.id);
    await waitIdle(engine, meeting.id);
    // Réunion traitée avant l'étape de copie : sa ligne n'existe pas encore.
    await db.delete(pipelineSteps).where(and(eq(pipelineSteps.meetingId, meeting.id), eq(pipelineSteps.step, 'export')));
    calls.length = 0;
    await engine.regenerate(meeting.id, false, '555'); // ce que font « Corriger » et « Régénérer »
    await waitIdle(engine, meeting.id);
    expect(calls).toEqual(['summarize', 'publish', 'export']);
  }, 30_000);

  it('échec passager (serveur injoignable) : relances automatiques, puis un seul avis d’échec, retiré à la réussite', async () => {
    const meeting = (await repos.updateMeeting((await seedMeeting()).id, { threadId: 'thread-auto', organizerId: '900' }))!;
    const { thread, sent, deleted } = fakeThread('thread-auto');
    const d = { ...deps(), client: { guilds: { fetch: async () => ({ premiumTier: 0 }) }, channels: { fetch: async () => thread } } as unknown as Client };
    let failures = 5;
    const calls: string[] = [];
    const quick: StepFn = async () => ({});
    const engine = new PipelineService(d, {
      mix: quick,
      summarize: quick,
      publish: quick,
      export: quick,
      transcribe: async (ctx) => {
        if (ctx.meeting.id !== meeting.id) return {};
        calls.push('transcribe');
        if (failures-- > 0) throw new Error('Transcription impossible après 3 tours : vibe-pc : indisponible');
        return {};
      },
    });
    engine.autoRetryDelaysMs = [5, 5, 5];
    const notices = () => sent.filter((p) => typeof p.content === 'string' && (p.content as string).includes("n'a pas pu être terminé"));
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    };

    await engine.schedule(meeting.id);
    // 1 essai + 3 relances automatiques, puis l'échec est annoncé (une fois).
    await waitFor(() => notices().length === 1);
    await waitIdle(engine, meeting.id);
    expect(calls).toHaveLength(4);
    expect(notices()).toHaveLength(1);
    expect((await repos.listPipeline(meeting.id)).find((r) => r.step === 'transcribe')?.status).toBe('failed');

    // Relance manuelle : de nouveau 1 essai + 1 relance, la 2e réussit ; l'avis d'échec est retiré.
    await engine.retry(meeting.id);
    await waitFor(() => (calls.length === 6 && !engine.isQueued(meeting.id)));
    await waitIdle(engine, meeting.id);
    expect(calls).toHaveLength(6);
    expect(notices()).toHaveLength(1);
    expect(deleted.length).toBeGreaterThanOrEqual(1);
    expect((await repos.getMeeting(meeting.id))?.failureNoticeId).toBeNull();
    expect((await repos.listPipeline(meeting.id)).every((r) => r.status === 'done')).toBe(true);
  }, 30_000);

  it('moteur : audio complet et transcription en parallèle ; un échec du mix laisse finir la transcription', async () => {
    const meeting = await seedMeeting();
    const calls: string[] = [];
    let mixFails = true;
    let releaseMix!: () => void;
    const mixGate = new Promise<void>((r) => (releaseMix = r));
    const fake = (name: string): StepFn => async (ctx) => {
      if (ctx.meeting.id === meeting.id) calls.push(name);
      return {};
    };
    const engine = new PipelineService(deps(), {
      mix: async (ctx) => {
        if (ctx.meeting.id !== meeting.id) return {};
        calls.push('mix');
        if (!mixFails) return {};
        await mixGate; // la transcription se termine pendant le mix
        throw new Error('ffmpeg KO');
      },
      transcribe: async (ctx) => {
        if (ctx.meeting.id !== meeting.id) return {};
        calls.push('transcribe');
        releaseMix();
        return {};
      },
      summarize: fake('summarize'),
      publish: fake('publish'),
      export: fake('export'),
    });

    await engine.schedule(meeting.id);
    await waitIdle(engine, meeting.id);
    expect(calls.sort()).toEqual(['mix', 'transcribe']);
    const rows = await repos.listPipeline(meeting.id);
    expect(rows.map((r) => [r.step, r.status])).toEqual([
      ['mix', 'failed'],
      ['transcribe', 'done'],
      ['summarize', 'pending'],
      ['publish', 'pending'],
      ['export', 'pending'],
    ]);

    // Relancer : seul le mix est refait, puis la suite.
    calls.length = 0;
    mixFails = false;
    await engine.retry(meeting.id);
    await waitIdle(engine, meeting.id);
    expect(calls).toEqual(['mix', 'summarize', 'publish', 'export']);
  }, 30_000);

  it('moteur : « Relancer » pendant que l’autre étape parallèle tourne : reprise à la fin', async () => {
    const meeting = await seedMeeting();
    const calls: string[] = [];
    let transcribeFails = true;
    let releaseMix!: () => void;
    const mixGate = new Promise<void>((r) => (releaseMix = r));
    let failedOnce!: () => void;
    const transcribeFailed = new Promise<void>((r) => (failedOnce = r));
    const quick: StepFn = async (ctx) => {
      if (ctx.meeting.id === meeting.id) calls.push('next');
      return {};
    };
    const engine = new PipelineService(deps(), {
      mix: async (ctx) => {
        if (ctx.meeting.id !== meeting.id) return {};
        calls.push('mix');
        await mixGate;
        return {};
      },
      transcribe: async (ctx) => {
        if (ctx.meeting.id !== meeting.id) return {};
        calls.push('transcribe');
        if (transcribeFails) {
          transcribeFails = false;
          failedOnce();
          throw new Error('format audio refusé'); // échec non passager : ❌ et « Relancer »
        }
        return {};
      },
      summarize: quick,
      publish: quick,
      export: quick,
    });

    await engine.schedule(meeting.id);
    await transcribeFailed;
    for (let i = 0; i < 200 && (await repos.listPipeline(meeting.id)).find((r) => r.step === 'transcribe')?.status !== 'failed'; i++) await new Promise((r) => setTimeout(r, 10));
    await engine.retry(meeting.id); // l'audio complet tourne encore
    releaseMix();
    for (let i = 0; i < 300 && calls.filter((c) => c === 'next').length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    await waitIdle(engine, meeting.id);
    expect(calls.filter((c) => c === 'transcribe')).toHaveLength(2);
    expect((await repos.listPipeline(meeting.id)).every((r) => r.status === 'done')).toBe(true);
  }, 30_000);

  it('moteur : au démarrage, un traitement en échec n’est pas repris (il attend « Relancer »)', async () => {
    const meeting = await seedMeeting();
    const calls: string[] = [];
    const fake = (name: string): StepFn => async (ctx) => {
      if (ctx.meeting.id === meeting.id) calls.push(name);
      return {};
    };
    const engine = new PipelineService(deps(), { mix: fake('mix'), transcribe: fake('transcribe'), summarize: fake('summarize'), publish: fake('publish'), export: fake('export') });
    await repos.ensurePipeline(meeting.id);
    for (const step of ['mix', 'transcribe'] as const) await repos.updateStep(meeting.id, step, { status: 'done' });
    await repos.updateStep(meeting.id, 'summarize', { status: 'failed', error: 'résumé KO' });

    await engine.resume();
    await waitIdle(engine, meeting.id);
    expect(calls).toEqual([]);

    await engine.retry(meeting.id);
    await waitIdle(engine, meeting.id);
    expect(calls).toEqual(['summarize', 'publish', 'export']);
  }, 30_000);

  it('moteur : « Réessayer maintenant » relance sans attendre le délai automatique', async () => {
    const meeting = await seedMeeting();
    let failures = 1;
    const calls: string[] = [];
    const quick: StepFn = async () => ({});
    const engine = new PipelineService(deps(), {
      mix: quick,
      summarize: quick,
      publish: quick,
      export: quick,
      transcribe: async (ctx) => {
        if (ctx.meeting.id !== meeting.id) return {};
        calls.push('transcribe');
        if (failures-- > 0) throw new Error('vibe-pc : indisponible');
        return {};
      },
    });
    engine.autoRetryDelaysMs = [60_000, 60_000, 60_000];
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    };

    await engine.schedule(meeting.id);
    await waitFor(() => calls.length === 1 && !engine.isQueued(meeting.id));
    await waitIdle(engine, meeting.id);
    expect((await repos.listPipeline(meeting.id)).find((r) => r.step === 'transcribe')?.status).toBe('pending');

    await engine.retryNow(meeting.id);
    await waitFor(() => calls.length === 2 && !engine.isQueued(meeting.id));
    await waitIdle(engine, meeting.id);
    expect(calls).toHaveLength(2);
    expect((await repos.listPipeline(meeting.id)).every((r) => r.status === 'done')).toBe(true);
    await engine.stop();
  }, 30_000);

  it('moteur : échec → relance de l’étape seulement ; reprise après arrêt', async () => {
    const meeting = await seedMeeting();
    const calls: string[] = [];
    let failSummarize = true;
    // Seuls les appels de cette réunion comptent : la reprise relance aussi celles des autres tests.
    const fake = (name: string, fail = () => false): StepFn => async (ctx) => {
      if (ctx.meeting.id !== meeting.id) return {};
      calls.push(name);
      if (fail()) throw new Error(`${name} KO`);
      return { ok: true };
    };
    const engine = new PipelineService(deps(), {
      mix: fake('mix'),
      transcribe: fake('transcribe'),
      summarize: fake('summarize', () => failSummarize),
      publish: fake('publish'),
      export: fake('export'),
    });

    await engine.schedule(meeting.id);
    await waitIdle(engine, meeting.id);
    expect(inOrder(calls)).toEqual(['mix', 'transcribe', 'summarize']);
    expect((await repos.listPipeline(meeting.id)).map((r) => [r.step, r.status, r.error])).toEqual([
      ['mix', 'done', null],
      ['transcribe', 'done', null],
      ['summarize', 'failed', 'summarize KO'],
      ['publish', 'pending', null],
      ['export', 'pending', null],
    ]);

    failSummarize = false;
    await engine.retry(meeting.id);
    await waitIdle(engine, meeting.id);
    expect(inOrder(calls)).toEqual(['mix', 'transcribe', 'summarize', 'summarize', 'publish', 'export']);
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

/** Audio complet et transcription tournent en parallèle : leur ordre d'appel n'est pas garanti. */
function inOrder(calls: readonly string[]): string[] {
  const out = [...calls];
  for (let i = 0; i + 1 < out.length; i++) if (out[i] === 'transcribe' && out[i + 1] === 'mix') [out[i], out[i + 1]] = ['mix', 'transcribe'];
  return out;
}

async function waitIdle(engine: PipelineService, meetingId: string): Promise<void> {
  for (let i = 0; i < 200 && engine.isQueued(meetingId); i++) await new Promise((r) => setTimeout(r, 25));
}
