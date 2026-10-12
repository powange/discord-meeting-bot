import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageFlags } from 'discord.js';
import { LlmClient } from '../ai/llm/client.js';
import { summarizeMeeting } from '../ai/llm/summarize.js';
import { HttpTranscriptionBackend } from '../ai/transcription/backend.js';
import { TranscriptionPool } from '../ai/transcription/pool.js';
import type { MeetingRow } from '../db/schema.js';
import { renderReport, renderTranscriptMarkdown, resolvePerson } from '../discord/embeds/report.js';
import { ensureUnarchived } from '../discord/forum.js';
import { fetchThread } from '../discord/threads.js';
import { formatWhen } from '../domain/time.js';
import { buildBlocks, cleanSegments, dropEchoes, formatClock, formatLine, mergeTranscript, type TranscriptLine } from '../domain/transcript.js';
import type { PipelineStep } from '../domain/types.js';
import { bitrateForLimit, uploadLimitBytes } from '../domain/audio.js';
import { assembleWav, ffmpegPath, mixPlaced, type PlacedInput } from '../lib/ffmpeg.js';
import { effectiveBackends } from '../services/transcriptionBackends.js';
import type { PipelineDeps, StepContext, StepFn } from './runner.js';

/** Étapes du traitement post-réunion (phase 3). */
export function createSteps(deps: PipelineDeps): Record<PipelineStep, StepFn> {
  return {
    mix: (ctx) => mix(deps, ctx),
    transcribe: (ctx) => transcribe(deps, ctx),
    summarize: (ctx) => summarize(deps, ctx),
    publish: (ctx) => publish(deps, ctx),
  };
}

// ---------------------------------------------------------------- audio complet

/**
 * Audio complet de la réunion : toutes les prises de parole (de toutes les sessions) replacées
 * sur une même ligne de temps, en Opus mono. Publié aussitôt dans le post (lecteur Discord) si
 * le fichier tient dans la limite d'envoi du serveur ; sinon conservé sur le serveur.
 */
async function mix(deps: PipelineDeps, ctx: StepContext): Promise<Record<string, unknown>> {
  const { repos, config, client } = deps;
  const { meeting, settings, m, signal } = ctx;
  const recordings = await repos.listRecordingsForMeeting(meeting.id);
  const origin = recordings[0]?.startedAt.getTime();
  const inputs: PlacedInput[] = [];
  let endMs = 0;
  for (const rec of recordings) {
    const shift = rec.startedAt.getTime() - origin!;
    for (const seg of await repos.listSegments(rec.id)) {
      inputs.push({ file: seg.filePath, offsetMs: shift + seg.startMs });
      endMs = Math.max(endMs, shift + seg.endMs);
    }
  }
  if (inputs.length === 0) return { empty: true };

  const thread = await fetchThread(client, meeting.threadId);
  const guild = await client.guilds.fetch(meeting.guildId).catch(() => null);
  const limit = uploadLimitBytes(guild?.premiumTier ?? 0);
  const kbps = bitrateForLimit(endMs, limit);

  // Republication (retranscription complète) : l'ancien message audio est remplacé.
  const previous = (await repos.listPipeline(meeting.id)).find((r) => r.step === 'mix')?.output;
  if (thread && typeof previous?.messageId === 'string') await thread.messages.delete(previous.messageId).catch(() => undefined);

  const dir = join(config.dataDir, 'meetings', meeting.guildId, meeting.id);
  const tmp = join(dir, 'tmp');
  await mkdir(tmp, { recursive: true });
  const fileName = `reunion-${formatWhen(meeting.startsAt, settings.timezone, settings.locale, 'yyyy-MM-dd-HH\'h\'mm')}.ogg`;
  const file = join(dir, fileName);
  ctx.progress(m.pipeline.progressMix(m.format.duration(endMs)));
  try {
    await mixPlaced(ffmpegPath(config.ffmpegPath), inputs, file, ['-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', `${kbps ?? 24}k`, '-application', 'voip'], tmp, signal);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const size = (await stat(file)).size;
  const output: Record<string, unknown> = { file, sizeBytes: size, durationMs: endMs, bitrateKbps: kbps ?? 24 };
  if (!thread) return output;

  await ensureUnarchived(thread);
  const attach = kbps !== null && size <= limit;
  const message = await thread.send({
    content: attach ? m.audio.published(m.format.duration(endMs)) : m.audio.tooLarge(m.format.duration(endMs), Math.round(size / 1024 / 1024)),
    ...(attach ? { files: [{ attachment: file, name: fileName }] } : {}),
    flags: MessageFlags.SuppressNotifications,
    allowedMentions: { parse: [] },
  });
  return { ...output, attached: attach, messageId: message.id, url: message.url };
}

// ---------------------------------------------------------------- transcription

/**
 * Prises de parole regroupées en blocs par personne, assemblées en WAV 16 kHz mono et envoyées
 * au premier backend disponible. Chaque bloc est enregistré dès qu'il est transcrit : une
 * relance reprend là où on s'était arrêté.
 */
async function transcribe(deps: PipelineDeps, ctx: StepContext): Promise<Record<string, unknown>> {
  const { repos, config } = deps;
  const { meeting, signal } = ctx;
  const cfg = config.guild(meeting.guildId).transcription;

  const recordings = await repos.listRecordingsForMeeting(meeting.id);
  const byId = new Map(recordings.map((r) => [r.id, r]));
  const rows = [];
  for (const rec of recordings) {
    const segments = await repos.listSegments(rec.id);
    for (const block of buildBlocks(segments, cfg.maxGapSec * 1000, cfg.maxBlockMin * 60_000)) {
      rows.push({ recordingId: rec.id, userId: block.userId, startMs: block.startMs, endMs: block.endMs, segmentIds: block.segments.map((s) => s.id) });
    }
  }
  const blocks = await repos.upsertBlocks(meeting.id, rows);
  const pending = blocks.filter((b) => !b.done);
  let done = blocks.length - pending.length;
  ctx.progress(ctx.m.pipeline.progressTranscribe(done, blocks.length));
  if (pending.length === 0) return { blocks: blocks.length };

  // Vocabulaire : noms des participants et points d'ODJ, pour aider la reconnaissance.
  const names = [...(await repos.displayNamesForMeeting(meeting.id)).values()];
  const agenda = (await repos.listAgenda(meeting.id)).map((a) => a.title);
  const prompt = [cfg.prompt, [...names, ...agenda].join(', ')].filter(Boolean).join(' ').slice(0, 800) || undefined;

  const { backends } = await effectiveBackends(repos, config, meeting.guildId);
  const pool = new TranscriptionPool(
    backends.map((b) => new HttpTranscriptionBackend(b, config.ai.allowedHosts)),
    ctx.log,
  );
  const ffmpeg = ffmpegPath(config.ffmpegPath);
  const tmp = join(config.dataDir, 'tmp', meeting.id);
  await mkdir(tmp, { recursive: true });

  try {
    const queue = [...pending];
    const worker = async () => {
      for (let block = queue.shift(); block; block = queue.shift()) {
        signal.throwIfAborted();
        const rec = byId.get(block.recordingId)!;
        const segments = await repos.segmentsByIds(block.segmentIds);
        const wav = join(tmp, `bloc-${block.id}.wav`);
        await assembleWav(
          ffmpeg,
          segments.map((s) => ({ file: s.filePath, offsetMs: s.startMs - block.startMs })),
          wav,
          signal,
        );
        const audio = new Blob([await readFile(wav)], { type: 'audio/wav' });
        const result = await pool.transcribe(audio, `bloc-${block.id}.wav`, { language: cfg.language, prompt }, signal);
        await rm(wav, { force: true });

        const origin = rec.startedAt.getTime() + block.startMs;
        const lines = cleanSegments(result.segments).map((s) => ({
          userId: block.userId,
          startAt: new Date(origin + s.start * 1000),
          endAt: new Date(origin + Math.max(s.end, s.start) * 1000),
          text: s.text,
        }));
        await repos.completeBlock(block.id, meeting.id, lines, result.backend, result.model);
        ctx.progress(`${ctx.m.pipeline.progressTranscribe(++done, blocks.length)} · ${result.backend}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(pool.capacity, pending.length)) }, worker));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return { blocks: blocks.length };
}

// ---------------------------------------------------------------- résumé

interface Transcript {
  lines: TranscriptLine[];
  names: Map<string, string>;
}

async function loadTranscript(deps: PipelineDeps, meeting: MeetingRow): Promise<Transcript> {
  const names = await deps.repos.displayNamesForMeeting(meeting.id);
  const all = await deps.repos.listTranscript(meeting.id);
  const rows = deps.config.guild(meeting.guildId).transcription.dropEchoes ? dropEchoes(all) : all;
  const lines = mergeTranscript(rows.map((r) => ({ userId: r.userId, name: names.get(r.userId) ?? r.userId, startAt: r.startAt, text: r.text })));
  return { lines, names };
}

async function summarize(deps: PipelineDeps, ctx: StepContext): Promise<Record<string, unknown>> {
  const { repos, config } = deps;
  const { meeting, settings, m } = ctx;
  const cfg = config.guild(meeting.guildId).llm;
  const { lines, names } = await loadTranscript(deps, meeting);
  const backends = [...new Set((await repos.upsertBlocks(meeting.id, [])).filter((b) => b.backend).map((b) => `${b.backend} (${b.model})`))];

  if (lines.length === 0) {
    await repos.saveSummary({ meetingId: meeting.id, content: { overview: '', topics: [] }, llmModel: '-', llmDeployments: [], transcriptionBackends: backends, passes: 0 });
    return { passes: 0 };
  }

  const llm = new LlmClient(cfg, config.ai.allowedHosts);
  const agenda = await repos.listAgenda(meeting.id);
  const result = await summarizeMeeting(
    llm,
    {
      title: meeting.title,
      description: meeting.description,
      date: formatWhen(meeting.startsAt, settings.timezone, settings.locale, m.format.when),
      participants: [...new Set(names.values())],
      agenda: agenda.map((a) => ({ id: a.id, title: a.title, detail: a.detail })),
    },
    lines.map((l) => formatLine(l, settings.timezone)),
    cfg.chunkTokens,
    (pass, total) => ctx.progress(m.pipeline.progressSummarize(pass, total)),
    ctx.signal,
  );
  await repos.saveSummary({
    meetingId: meeting.id,
    content: result.summary,
    llmModel: llm.model,
    llmDeployments: result.models,
    transcriptionBackends: backends,
    passes: result.passes,
  });
  return { passes: result.passes, models: result.models };
}

// ---------------------------------------------------------------- publication

async function publish(deps: PipelineDeps, ctx: StepContext): Promise<Record<string, unknown>> {
  const { repos, client } = deps;
  const { meeting, settings, m } = ctx;
  const thread = await fetchThread(client, meeting.threadId);
  if (!thread) throw new Error('Post de la réunion introuvable');

  // Republication (compte rendu régénéré) : l'ancien compte rendu est remplacé.
  const previous = (await repos.listPipeline(meeting.id)).find((r) => r.step === 'publish')?.output;
  for (const id of Array.isArray(previous?.messageIds) ? (previous.messageIds as string[]) : []) {
    await thread.messages.delete(id).catch(() => undefined);
  }

  const summary = await repos.getSummary(meeting.id);
  const { lines, names } = await loadTranscript(deps, meeting);
  await ensureUnarchived(thread);
  if (!summary || lines.length === 0) {
    const message = await thread.send({ content: m.report.noSpeech, flags: MessageFlags.SuppressNotifications });
    return { messageIds: [message.id], url: message.url };
  }

  const recordings = await repos.listRecordingsForMeeting(meeting.id);
  const durationMs = recordings.reduce((n, r) => n + ((r.endedAt ?? r.startedAt).getTime() - r.startedAt.getTime()), 0);
  const subtitle = m.report.subtitle(formatWhen(meeting.startsAt, settings.timezone, settings.locale, m.format.when), m.format.duration(durationMs), names.size);
  const people = new Map([...names].map(([id, name]) => [name, id]));
  const llmTrace = summary.llmDeployments.length ? summary.llmDeployments.join(', ') : summary.llmModel;
  const transcriptFile = `transcription-${meeting.startsAt.toISOString().slice(0, 10)}.md`;
  const mixOutput = (await repos.listPipeline(meeting.id)).find((r) => r.step === 'mix')?.output;
  const audioUrl = typeof mixOutput?.url === 'string' ? mixOutput.url : undefined;

  const containers = renderReport(
    {
      title: meeting.title,
      subtitle,
      agenda: (await repos.listAgenda(meeting.id)).map((a) => ({ id: a.id, title: a.title })),
      summary: summary.content,
      people,
      trace: m.report.trace(summary.transcriptionBackends.join(', ') || '-', llmTrace, summary.passes),
      transcriptFile,
      ...(audioUrl ? { audioUrl } : {}),
    },
    m,
  );
  const markdown = renderTranscriptMarkdown(
    meeting.title,
    subtitle,
    lines.map((l) => ({ time: formatClock(l.startAt, settings.timezone), name: l.name, text: l.text })),
  );

  // Les responsables d'actions sont notifiés ; le reste du compte rendu est silencieux.
  const assignees = summary.content.topics
    .flatMap((t) => t.actions.map((a) => (a.who ? resolvePerson(a.who, people) : '')))
    .flatMap((mention) => /^<@(\d+)>$/.exec(mention)?.slice(1) ?? []);

  const ids: string[] = [];
  let url = '';
  for (const [i, container] of containers.entries()) {
    const last = i === containers.length - 1;
    const message = await thread.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { users: [...new Set(assignees)] },
      ...(last ? { files: [{ attachment: Buffer.from(markdown, 'utf8'), name: transcriptFile }] } : {}),
    });
    ids.push(message.id);
    if (i === 0) url = message.url;
  }
  return { messageIds: ids, url };
}
