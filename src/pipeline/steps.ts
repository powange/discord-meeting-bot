import { existsSync, openAsBlob } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MessageFlags, type APIContainerComponent, type ThreadChannel } from 'discord.js';
import { LlmClient } from '../ai/llm/client.js';
import { FailoverLlm } from '../ai/llm/failover.js';
import { summarizeMeeting, type SummaryCheckpoint } from '../ai/llm/summarize.js';
import type { MeetingSummary } from '../ai/llm/schema.js';
import { HttpTranscriptionBackend } from '../ai/transcription/backend.js';
import { TranscriptionPool } from '../ai/transcription/pool.js';
import type { MeetingRow } from '../db/schema.js';
import { renderReport, renderReportMarkdown, renderTranscriptMarkdown, resolvePerson, type ReportInput, type TranscriptEntry } from '../discord/embeds/report.js';
import { interleave, markerText, pointDurations } from '../domain/markers.js';
import { ensureUnarchived } from '../discord/forum.js';
import { fetchThread, isUnknownMessage } from '../discord/threads.js';
import { meetingFolderName } from '../domain/storage.js';
import { formatWhen } from '../domain/time.js';
import { whisperPrompt } from '../domain/vocabulary.js';
import { buildBlocks, cleanSegments, dropEchoes, formatClock, formatLine, mergeTranscript, type TranscriptLine } from '../domain/transcript.js';
import type { PipelineStep } from '../domain/types.js';
import { clock, planParts, uploadLimitBytes } from '../domain/audio.js';
import { assembleWav, ffmpegPath, mixPlaced, runFfmpeg, splitAudio, type PlacedInput } from '../lib/ffmpeg.js';
import { isContextOverflow } from '../domain/failure.js';
import { renderReportPdf } from '../report/pdf.js';
import { errorMessage } from '../lib/errors.js';
import { effectiveLlms } from '../services/llmSettings.js';
import type { UploadFile } from '../services/storage.js';
import { effectiveBackends } from '../services/transcriptionBackends.js';
import type { PipelineDeps, StepContext, StepFn } from './runner.js';

/** Étapes du traitement post-réunion (phase 3). */
export function createSteps(deps: PipelineDeps): Record<PipelineStep, StepFn> {
  return {
    mix: (ctx) => mix(deps, ctx),
    transcribe: (ctx) => transcribe(deps, ctx),
    summarize: (ctx) => summarize(deps, ctx),
    publish: (ctx) => publish(deps, ctx),
    export: (ctx) => exportFiles(deps, ctx),
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
  // Sessions terminées seulement : une session en cours sera prise à son arrêt (nouveau traitement).
  const recordings = (await repos.listRecordingsForMeeting(meeting.id)).filter((r) => r.endedAt);
  const origin = recordings[0]?.startedAt.getTime();
  const placed = new Map<string, PlacedInput[]>(); // par session
  let endMs = 0;
  for (const rec of recordings) {
    const shift = rec.startedAt.getTime() - origin!;
    const list: PlacedInput[] = [];
    for (const seg of await repos.listSegments(rec.id)) {
      list.push({ file: seg.filePath, offsetMs: shift + seg.startMs, track: seg.userId });
      endMs = Math.max(endMs, shift + seg.endMs);
    }
    placed.set(rec.id, list);
  }
  const segmentCounts = Object.fromEntries([...placed].map(([id, list]) => [id, list.length]));
  if ([...placed.values()].every((list) => list.length === 0)) return { empty: true };

  const thread = await fetchThread(client, meeting.threadId);
  const guild = await client.guilds.fetch(meeting.guildId).catch(() => null);
  const limit = uploadLimitBytes(guild?.premiumTier ?? 0);
  // Un seul fichier s'il tient dans la limite d'envoi, sinon plusieurs parties (≤ 10).
  const plan = planParts(endMs, limit);
  const kbps = plan?.kbps ?? 24;

  // Republication (nouvelle session, retranscription) : les anciens messages audio sont remplacés,
  // mais supprimés seulement une fois le nouvel audio publié (un échec ne laisse pas le post vide).
  const previous = (await repos.listPipeline(meeting.id)).find((r) => r.step === 'mix')?.output;
  const previousIds = [
    ...(Array.isArray(previous?.messageIds) ? (previous.messageIds as string[]) : []),
    ...(typeof previous?.messageId === 'string' ? [previous.messageId] : []),
  ];

  const dir = join(config.dataDir, 'meetings', meeting.guildId, meeting.id);
  const tmp = join(dir, 'tmp');
  await mkdir(tmp, { recursive: true });
  const base = `reunion-${formatWhen(meeting.startsAt, settings.timezone, settings.locale, "yyyy-MM-dd-HH'h'mm")}`;
  const fileName = `${base}.ogg`;
  const file = join(dir, fileName);
  // Mix sans perte (FLAC) gardé à côté : une nouvelle session s'y ajoute sans tout remixer, et
  // l'audio déjà mixé n'est jamais réencodé plusieurs fois en Opus.
  const master = join(dir, `${base}.flac`);
  const ffmpeg = ffmpegPath(config.ffmpegPath);

  // Incrémental si le mix précédent couvre exactement les sessions déjà mixées (mêmes prises
  // de parole) et que seules de nouvelles sessions sont arrivées ; sinon (retranscription,
  // session modifiée, fichier absent), mix complet. Le contenu du FLAC est décrit par un
  // manifeste écrit juste après lui : un échec plus loin (envoi sur Discord, arrêt du bot) ne
  // fait pas croire que la nouvelle session manque encore (elle serait mixée deux fois).
  const prevMaster = typeof previous?.master === 'string' ? previous.master : null;
  const prevCounts = prevMaster ? await readManifest(prevMaster) : null;
  const added = recordings.filter((r) => !prevCounts || !(r.id in prevCounts));
  const incremental =
    prevMaster !== null &&
    prevCounts !== null &&
    existsSync(prevMaster) &&
    added.length > 0 &&
    Object.entries(prevCounts).every(([id, n]) => segmentCounts[id] === n);
  const inputs: PlacedInput[] = incremental
    ? [{ file: prevMaster!, offsetMs: 0 }, ...added.flatMap((r) => placed.get(r.id) ?? [])]
    : [...placed.values()].flat();

  ctx.progress(m.pipeline.progressMix(m.format.duration(endMs)));
  let parts: string[] = [];
  try {
    const nextMaster = join(tmp, 'master.flac');
    await mixPlaced(ffmpeg, inputs, nextMaster, ['-threads', '1', '-ac', '1', '-ar', '48000', '-c:a', 'flac'], tmp, signal);
    // Manifeste retiré avant le remplacement : un arrêt entre les deux donne un mix complet, sûr.
    await rm(manifestPath(master), { force: true });
    if (prevMaster && prevMaster !== master) await rm(manifestPath(prevMaster), { force: true });
    await rename(nextMaster, master);
    await writeFile(manifestPath(master), JSON.stringify(segmentCounts));
    await runFfmpeg(ffmpeg, ['-threads', '1', '-i', master, '-ac', '1', '-c:a', 'libopus', '-b:a', `${kbps}k`, '-application', 'voip', file], signal);
    if (plan && plan.parts > 1) parts = await splitAudio(ffmpeg, file, plan.partMs, plan.parts, (i) => join(dir, `${base}-partie${i + 1}.ogg`), signal);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const size = (await stat(file)).size;
  const output: Record<string, unknown> = { file, master, parts, sizeBytes: size, durationMs: endMs, bitrateKbps: kbps, segmentCounts, incremental };
  if (!thread) {
    await removeStaleAudio(previous, output, dir);
    return output;
  }
  await ensureUnarchived(thread);

  const sent: string[] = [];
  const send = async (content: string, attachment?: { path: string; name: string }) => {
    const message = await thread.send({
      content,
      ...(attachment ? { files: [{ attachment: attachment.path, name: attachment.name }] } : {}),
      flags: MessageFlags.SuppressNotifications,
      allowedMentions: { parse: [] },
    });
    sent.push(message.id);
    return message;
  };
  const duration = m.format.duration(endMs);

  const post = async (): Promise<{ attached: boolean; url: string }> => {
    if (!plan || (parts.length === 0 && size > limit)) {
      return { attached: false, url: (await send(m.audio.tooLarge(duration, Math.round(size / 1024 / 1024)))).url };
    }
    if (parts.length === 0) return { attached: true, url: (await send(m.audio.published(duration), { path: file, name: fileName })).url };
    // Une partie par message : la limite d'envoi peut s'appliquer au message entier.
    let url = '';
    for (const [i, part] of parts.entries()) {
      const from = clock(i * plan.partMs);
      const to = clock(Math.min(endMs, (i + 1) * plan.partMs));
      const tooBig = (await stat(part)).size > limit;
      const content = `${i === 0 ? `${m.audio.publishedParts(duration, parts.length)}\n` : ''}${m.audio.part(i + 1, parts.length, from, to)}`;
      const message = await send(tooBig ? `${content} · ${m.audio.partTooLarge}` : content, tooBig ? undefined : { path: part, name: `${base}-partie${i + 1}.ogg` });
      if (i === 0) url = message.url;
    }
    return { attached: true, url };
  };
  let posted: { attached: boolean; url: string };
  try {
    posted = await post();
  } catch (err) {
    // Envoi partiel : on retire ce qui est parti, la relance republiera tout (sans doublon).
    await deleteMessages(thread, sent);
    throw err;
  }
  await deleteMessages(thread, previousIds);
  await removeStaleAudio(previous, output, dir);
  return { ...output, ...posted, messageIds: sent };
}

/**
 * Fichiers de l'ancien mix qui ne servent plus (moins de parties, autre nom après un changement
 * de date ou de fuseau) : la rétention ne connaît que le mix actuel, ils resteraient sur le disque.
 */
async function removeStaleAudio(previous: Record<string, unknown> | null | undefined, current: Record<string, unknown>, dir: string): Promise<void> {
  const paths = (o: Record<string, unknown> | null | undefined) => [o?.file, o?.master, ...(Array.isArray(o?.parts) ? o.parts : [])].filter((f): f is string => typeof f === 'string');
  const keep = new Set(paths(current));
  for (const file of paths(previous)) {
    if (keep.has(file) || !file.startsWith(dir)) continue;
    await rm(file, { force: true }).catch(() => undefined);
    if (file.endsWith('.flac')) await rm(manifestPath(file), { force: true }).catch(() => undefined);
  }
}

const manifestPath = (master: string) => `${master}.json`;

/** Sessions contenues dans un mix sans perte (id → nombre de prises de parole) ; null si inconnu. */
async function readManifest(master: string): Promise<Record<string, number> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath(master), 'utf8'));
    return value && typeof value === 'object' ? (value as Record<string, number>) : null;
  } catch {
    return null;
  }
}

/** Suppression de messages du bot, sans échouer sur ceux déjà supprimés à la main. */
async function deleteMessages(thread: ThreadChannel, ids: readonly string[]): Promise<void> {
  for (const id of ids) await thread.messages.delete(id).catch(() => undefined);
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

  // Sessions terminées et non purgées : les blocs d'une session en cours seraient incomplets, ceux
  // d'une session purgée (audio supprimé) sont gardés tels quels.
  const recordings = (await repos.listRecordingsForMeeting(meeting.id)).filter((r) => r.endedAt && !r.purgedAt);
  const byId = new Map(recordings.map((r) => [r.id, r]));
  const rows = [];
  for (const rec of recordings) {
    const segments = await repos.listSegments(rec.id);
    for (const block of buildBlocks(segments, cfg.maxGapSec * 1000, cfg.maxBlockMin * 60_000)) {
      rows.push({ recordingId: rec.id, userId: block.userId, startMs: block.startMs, endMs: block.endMs, segmentIds: block.segments.map((s) => s.id) });
    }
  }
  const blocks = (await repos.syncBlocks(meeting.id, recordings.map((r) => r.id), rows)).filter((b) => byId.has(b.recordingId));
  const pending = blocks.filter((b) => !b.done);
  let done = blocks.length - pending.length;
  ctx.progress(ctx.m.pipeline.progressTranscribe(done, blocks.length));
  if (pending.length === 0) return { blocks: blocks.length };

  // Vocabulaire pour aider la reconnaissance : celui du serveur, les noms propres des consignes de
  // correction (utile quand on refait la transcription), les participants et les points d'ODJ.
  const prompt = whisperPrompt({
    base: cfg.prompt,
    vocabulary: ctx.settings.vocabulary,
    corrections: (await repos.getSummary(meeting.id))?.corrections ?? [],
    names: [...(await repos.displayNamesForMeeting(meeting.id)).values()],
    agenda: (await repos.listAgenda(meeting.id)).map((a) => a.title),
  });

  const { backends } = await effectiveBackends(repos, config, meeting.guildId);
  const pool = new TranscriptionPool(
    backends.map((b) => new HttpTranscriptionBackend(b, config.ai.allowedHosts)),
    ctx.log,
  );
  const ffmpeg = ffmpegPath(config.ffmpegPath);
  const tmp = join(config.dataDir, 'tmp', meeting.id);
  await mkdir(tmp, { recursive: true });

  // Annulation commune : abandon du traitement, durée maximale dépassée, ou échec d'un bloc
  // (les autres s'arrêtent au lieu de continuer pendant qu'on supprime leur dossier).
  const failed = new AbortController();
  const tooLong = AbortSignal.timeout(cfg.stepMaxMin * 60_000);
  const stepSignal = AbortSignal.any([signal, failed.signal, tooLong]);
  try {
    const queue = [...pending];
    const worker = async () => {
      for (let block = queue.shift(); block; block = queue.shift()) {
        stepSignal.throwIfAborted();
        const rec = byId.get(block.recordingId)!;
        const segments = await repos.segmentsByIds(block.segmentIds);
        const wav = join(tmp, `bloc-${block.id}.wav`);
        await assembleWav(
          ffmpeg,
          segments.map((s) => ({ file: s.filePath, offsetMs: s.startMs - block.startMs })),
          wav,
          stepSignal,
        );
        const audio = await openAsBlob(wav, { type: 'audio/wav' }); // lu au fil de l'envoi, pas chargé en mémoire
        const result = await pool.transcribe(audio, `bloc-${block.id}.wav`, { language: cfg.language, prompt }, stepSignal);
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
    const results = await Promise.allSettled(
      Array.from({ length: Math.max(1, Math.min(pool.capacity, pending.length)) }, () =>
        worker().catch((err) => {
          failed.abort();
          throw err;
        }),
      ),
    );
    const firstError = results.find((r) => r.status === 'rejected')?.reason as unknown;
    if (firstError !== undefined) {
      // Durée maximale dépassée : échec clair, pas une relance automatique (« délai dépassé »).
      if (!signal.aborted && tooLong.aborted) throw new Error(ctx.m.pipeline.stepTooLong(cfg.stepMaxMin));
      // Erreur d'origine plutôt que les annulations qu'elle a provoquées chez les autres blocs.
      const original = results.find((r) => r.status === 'rejected' && !(r.reason instanceof Error && r.reason.name === 'AbortError'));
      throw (original as PromiseRejectedResult | undefined)?.reason ?? firstError;
    }
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
  const llmSettings = await effectiveLlms(repos, settings, config);
  const cfg = config.guild(meeting.guildId).llm;
  const { lines, names } = await loadTranscript(deps, meeting);
  const backends = [...new Set((await repos.listBlocks(meeting.id)).filter((b) => b.backend).map((b) => `${b.backend} (${b.model})`))];

  if (lines.length === 0) {
    await repos.saveSummary({ meetingId: meeting.id, content: { overview: '', topics: [] }, llmModel: '-', llmDeployments: [], transcriptionBackends: backends, passes: 0 });
    return { passes: 0 };
  }
  // Résumé facultatif : sans LLM configuré (ou désactivé), l'étape est sautée et la transcription publiée seule.
  if (llmSettings.servers.length === 0 || !llmSettings.enabled) {
    await repos.saveSummary({ meetingId: meeting.id, content: { overview: '', topics: [] }, llmModel: '-', llmDeployments: [], transcriptionBackends: backends, passes: 0 });
    return { skipped: true };
  }

  // Serveurs par ordre de priorité : le suivant prend le relais si l'un échoue.
  // Un serveur qui a un secours derrière lui ne réessaie pas : la bascule est plus rapide que
  // plusieurs délais d'attente ; seul le dernier garde ses nouvelles tentatives.
  const last = llmSettings.servers.length - 1;
  const llm = new FailoverLlm(
    llmSettings.servers.map((s, i) => ({
      name: s.name,
      client: new LlmClient(s.config, config.ai.allowedHosts, i < last ? { attempts: 1, delayMs: 0 } : undefined),
    })),
    ctx.log,
  );
  const agenda = await repos.listAgenda(meeting.id);
  const corrections = (await repos.getSummary(meeting.id))?.corrections ?? [];
  // Repères pris en direct (point en cours, notes) insérés à leur heure dans la transcription.
  const transcript = interleave(
    lines.map((l) => ({ at: l.startAt, value: formatLine(l, settings.timezone) })),
    (await repos.listMarkers(meeting.id)).map((mk) => ({ at: mk.at, value: `[${formatClock(mk.at, settings.timezone)}] ${markerText(mk, agenda)}` })),
  );
  // Notes partielles gardées dans l'étape en cours : après un redémarrage du bot, le résumé
  // reprend au morceau suivant au lieu de tout redemander au modèle.
  let saved = (await repos.listPipeline(meeting.id)).find((r) => r.step === 'summarize')?.output?.checkpoint as { key: string; partials: MeetingSummary[] } | undefined;
  const checkpoint: SummaryCheckpoint = {
    load: (key) => (saved?.key === key ? saved.partials : undefined),
    save: async (key, partials) => {
      saved = { key, partials: [...partials] };
      await repos.updateStep(meeting.id, 'summarize', { output: { checkpoint: saved } });
    },
  };
  const run = (chunkTokens: number) =>
    summarizeMeeting(
      llm,
      {
        title: meeting.title,
        description: meeting.description,
        date: formatWhen(meeting.startsAt, settings.timezone, settings.locale, m.format.when),
        participants: [...new Set(names.values())],
        agenda: agenda.map((a) => ({ id: a.id, title: a.title, detail: a.detail })),
        vocabulary: settings.vocabulary,
        corrections,
      },
      transcript,
      chunkTokens,
      (pass, total) => ctx.progress(m.pipeline.progressSummarize(pass, total)),
      ctx.signal,
      checkpoint,
    );
  // Modèle chargé avec un contexte trop petit pour les morceaux (LM Studio : 4096 ou 8192 par
  // défaut) : on recommence avec des morceaux deux fois plus petits, jusqu'à 1500 tokens.
  let chunkTokens = cfg.chunkTokens;
  let result: Awaited<ReturnType<typeof run>>;
  for (;;) {
    try {
      result = await run(chunkTokens);
      break;
    } catch (err) {
      if (!isContextOverflow(errorMessage(err)) || chunkTokens <= 1500 || ctx.signal.aborted) throw err;
      chunkTokens = Math.max(1500, Math.floor(chunkTokens / 2));
      ctx.log.warn({ chunkTokens }, 'Contexte du modèle trop petit : résumé recommencé avec des morceaux plus petits');
      ctx.progress(m.pipeline.progressSmallerChunks(chunkTokens));
    }
  }
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

/** Contenu du compte rendu (publication dans Discord et copie vers le stockage) ; null sans parole. */
async function reportContent(deps: PipelineDeps, ctx: StepContext) {
  const { repos } = deps;
  const { meeting, settings, m } = ctx;
  const summary = await repos.getSummary(meeting.id);
  const { lines, names } = await loadTranscript(deps, meeting);
  if (!summary || lines.length === 0) return null;

  const recordings = await repos.listRecordingsForMeeting(meeting.id);
  const durationMs = recordings.reduce((n, r) => n + ((r.endedAt ?? r.startedAt).getTime() - r.startedAt.getTime()), 0);
  const subtitle = m.report.subtitle(formatWhen(meeting.startsAt, settings.timezone, settings.locale, m.format.when), m.format.duration(durationMs), names.size);
  const people = new Map([...names].map(([id, name]) => [name, id]));
  const llmTrace = summary.llmDeployments.length ? summary.llmDeployments.join(', ') : summary.llmModel;
  const summarizeStep = (await repos.listPipeline(meeting.id)).find((r) => r.step === 'summarize');
  const summaryDisabled = summarizeStep?.output?.skipped === true;
  // Date de la réunion dans le fuseau du serveur (une réunion à 1 h du matin n'est pas datée de la veille).
  const day = formatWhen(meeting.startsAt, settings.timezone, settings.locale, 'yyyy-MM-dd');
  const agendaRows = (await repos.listAgenda(meeting.id)).map((a) => ({ id: a.id, title: a.title, detail: a.detail }));
  const markers = await repos.listMarkers(meeting.id);
  const input: ReportInput = {
    title: meeting.title,
    subtitle,
    agenda: agendaRows,
    summary: summary.content,
    durations: pointDurations(markers, new Date(Math.max(...recordings.map((r) => (r.endedAt ?? r.startedAt).getTime())))),
    participants: [...names].map(([id, name]) => ({ id, name })),
    people,
    trace: summaryDisabled
      ? m.report.traceNoSummary(summary.transcriptionBackends.join(', ') || '-')
      : m.report.trace(summary.transcriptionBackends.join(', ') || '-', llmTrace, summary.passes),
    summaryDisabled,
  };
  const markdown = renderTranscriptMarkdown(
    meeting.title,
    subtitle,
    interleave<TranscriptEntry>(
      lines.map((l) => ({ at: l.startAt, value: { time: formatClock(l.startAt, settings.timezone), name: l.name, text: l.text } })),
      markers.map((mk) => ({ at: mk.at, value: { time: formatClock(mk.at, settings.timezone), marker: markerText(mk, agendaRows) } })),
    ),
  );
  return { summary, people, input, markdown, transcriptFile: `transcription-${day}.md`, reportFile: `compte-rendu-${day}.md`, pdfFile: `compte-rendu-${day}.pdf` };
}

async function publish(deps: PipelineDeps, ctx: StepContext): Promise<Record<string, unknown>> {
  const { repos, client } = deps;
  const { meeting, m } = ctx;
  const thread = await fetchThread(client, meeting.threadId);
  if (!thread) throw new Error('Post de la réunion introuvable');

  // Compte rendu déjà publié (correction, régénération) : édité sur place si possible, sinon
  // remplacé — le nouveau d'abord, l'ancien supprimé ensuite.
  const previous = (await repos.listPipeline(meeting.id)).find((r) => r.step === 'publish')?.output;
  const previousIds = Array.isArray(previous?.messageIds) ? (previous.messageIds as string[]) : [];
  const alreadyMentioned = new Set(Array.isArray(previous?.mentioned) ? (previous.mentioned as string[]) : []);

  const content = await reportContent(deps, ctx);
  await ensureUnarchived(thread);
  if (!content) {
    const message = await thread.send({ content: m.report.noSpeech, flags: MessageFlags.SuppressNotifications });
    await deleteMessages(thread, previousIds);
    return { messageIds: [message.id], url: message.url };
  }
  const { summary, people, transcriptFile, markdown, pdfFile } = content;
  // Compte rendu en PDF, téléchargeable depuis le dernier message (sans résumé : pas de PDF).
  const pdf = content.input.summaryDisabled ? null : await renderReportPdf(content.input, m);
  // Gardé à côté de l'audio : la copie vers le stockage le reprend sans le rendre de nouveau.
  let pdfPath: string | undefined;
  if (pdf) {
    const dir = join(deps.config.dataDir, 'meetings', meeting.guildId, meeting.id);
    await mkdir(dir, { recursive: true });
    pdfPath = join(dir, pdfFile);
    await writeFile(pdfPath, pdf);
  }
  const mixOutput = (await repos.listPipeline(meeting.id)).find((r) => r.step === 'mix')?.output;
  const audioUrl = typeof mixOutput?.url === 'string' ? mixOutput.url : undefined;
  // Message de l'ordre du jour du post, s'il y a des points.
  const agendaUrl = content.input.agenda.length && meeting.agendaMessageId ? `https://discord.com/channels/${meeting.guildId}/${meeting.threadId}/${meeting.agendaMessageId}` : undefined;
  const containers = renderReport(
    {
      ...content.input,
      ...(content.input.summaryDisabled ? {} : { correctMeetingId: meeting.id }),
      transcriptFile,
      ...(pdf ? { pdfFile } : {}),
      ...(audioUrl ? { audioUrl } : {}),
      ...(agendaUrl ? { agendaUrl } : {}),
    },
    m,
  );

  // Les responsables d'actions sont notifiés, une seule fois chacun : une correction ne
  // re-mentionne que les nouveaux. Le reste du compte rendu est silencieux.
  const assignees = [
    ...new Set(
      summary.content.topics
        .flatMap((t) => t.actions.map((a) => (a.who ? resolvePerson(a.who, people) : '')))
        .flatMap((mention) => /^<@(\d+)>$/.exec(mention)?.slice(1) ?? []),
    ),
  ];
  const toMention = assignees.filter((id) => !alreadyMentioned.has(id));
  const mentioned = [...new Set([...alreadyMentioned, ...assignees])];
  const attachments = () => [...(pdf ? [{ attachment: pdf, name: pdfFile }] : []), { attachment: Buffer.from(markdown, 'utf8'), name: transcriptFile }];

  // Même nombre de messages et personne de nouveau à prévenir : édition (liens conservés, aucune notification).
  if (previousIds.length === containers.length && toMention.length === 0) {
    // Republication seulement si un message a été supprimé ; une erreur passagère fait échouer l'étape.
    const url = await editReport(thread, previousIds, containers, attachments).catch((err: unknown) => {
      if (isUnknownMessage(err)) return null;
      throw err;
    });
    if (url) return { messageIds: previousIds, url, mentioned, ...(pdfPath ? { pdfPath } : {}) };
  }

  const sent: string[] = [];
  let url = '';
  try {
    for (const [i, container] of containers.entries()) {
      const last = i === containers.length - 1;
      const message = await thread.send({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { users: toMention },
        ...(last ? { files: attachments() } : {}),
      });
      sent.push(message.id);
      if (i === 0) url = message.url;
    }
  } catch (err) {
    await deleteMessages(thread, sent);
    throw err;
  }
  await deleteMessages(thread, previousIds);
  return { messageIds: sent, url, mentioned, ...(pdfPath ? { pdfPath } : {}) };
}

/** Édite le compte rendu publié ; null si un message manque (supprimé à la main) : il faut republier. */
async function editReport(
  thread: ThreadChannel,
  ids: readonly string[],
  containers: readonly APIContainerComponent[],
  attachments: () => Array<{ attachment: Buffer; name: string }>,
): Promise<string | null> {
  const messages = [];
  for (const id of ids) {
    const message = await thread.messages.fetch(id).catch((err: unknown) => {
      if (isUnknownMessage(err)) return null;
      throw err;
    });
    if (!message) return null;
    messages.push(message);
  }
  for (const [i, message] of messages.entries()) {
    const last = i === messages.length - 1;
    await message.edit({
      components: [containers[i]!],
      allowedMentions: { parse: [] },
      // Pièces jointes (PDF, transcription) remplacées par les nouvelles.
      ...(last ? { files: attachments(), attachments: [] } : {}),
    });
  }
  return messages[0]!.url;
}

// ---------------------------------------------------------------- copie vers le stockage

/**
 * Copie dans le stockage du serveur (/config → Stockage) : compte rendu et transcription en
 * Markdown, audio complet. Un dossier par réunion ; une mise à jour remplace les fichiers.
 */
async function exportFiles(deps: PipelineDeps, ctx: StepContext): Promise<Record<string, unknown>> {
  const { repos, storage } = deps;
  const { meeting, settings, m } = ctx;
  const target = storage ? await storage.get(meeting.guildId) : undefined;
  if (!storage || !target) return { skipped: true };
  const steps = await repos.listPipeline(meeting.id);
  const previous = steps.find((r) => r.step === 'export')?.output;
  const published = steps.find((r) => r.step === 'publish')?.output;

  const files: UploadFile[] = [];
  const content = await reportContent(deps, ctx);
  if (content) {
    if (!content.input.summaryDisabled) {
      files.push({ name: content.reportFile, source: { data: Buffer.from(renderReportMarkdown(content.input, m), 'utf8') }, mime: 'text/markdown' });
      // PDF rendu à la publication, repris tel quel.
      const pdfPath = typeof published?.pdfPath === 'string' && existsSync(published.pdfPath) ? published.pdfPath : null;
      files.push({ name: content.pdfFile, source: pdfPath ? { path: pdfPath } : { data: await renderReportPdf(content.input, m) }, mime: 'application/pdf' });
    }
    files.push({ name: content.transcriptFile, source: { data: Buffer.from(content.markdown, 'utf8') }, mime: 'text/markdown' });
  }
  const mix = steps.find((r) => r.step === 'mix')?.output;
  const audio = typeof mix?.file === 'string' && !mix.purgedAt && existsSync(mix.file) ? mix.file : null;
  // L'audio (jusqu'à 100 Mo) n'est renvoyé que s'il a changé, ou si le stockage n'est plus le même :
  // une correction du compte rendu ne le recopie pas.
  const destination = `${target.provider}:${target.folder}`;
  let audioSig: string | undefined;
  if (audio) {
    const st = await stat(audio);
    audioSig = `${basename(audio)}:${st.size}:${Math.round(st.mtimeMs)}`;
    if (previous?.audioSig !== audioSig || previous?.destination !== destination) files.push({ name: basename(audio), source: { path: audio }, mime: 'audio/ogg' });
  }
  if (files.length === 0) return { files: [] };

  ctx.progress(m.pipeline.progressExport(files.length));
  // Dossier de la réunion : celui de la première copie, même si le titre a changé depuis.
  const folder = typeof previous?.folder === 'string' ? previous.folder : meetingFolderName(formatWhen(meeting.startsAt, settings.timezone, settings.locale, "yyyy-MM-dd HH'h'mm"), meeting.title);
  const result = await storage.upload(meeting.guildId, folder, files, ctx.signal);
  if (!result) return { skipped: true };
  return { provider: result.provider, path: result.path, folder, destination, ...(audioSig ? { audioSig } : {}), files: files.map((f) => f.name) };
}
