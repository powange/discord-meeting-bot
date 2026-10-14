import { rm } from 'node:fs/promises';
import { MessageFlags, type Client } from 'discord.js';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import type { GuildSettingsRow, MeetingRow } from '../db/schema.js';
import { renderPipelineStatus, type StepView } from '../discord/embeds/pipelineStatus.js';
import { ensureUnarchived } from '../discord/forum.js';
import { fetchThread } from '../discord/threads.js';
import { PIPELINE_STEPS, type PipelineStep } from '../domain/types.js';
import { messages, type Messages } from '../i18n/index.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { SettingsService } from '../services/settings.js';
import type { StorageService } from '../services/storage.js';

export interface StepContext {
  meeting: MeetingRow;
  settings: GuildSettingsRow;
  m: Messages;
  signal: AbortSignal;
  log: Logger;
  /** Progression affichée dans le message de suivi (mises à jour regroupées). */
  progress(detail: string): void;
}

/** Une étape renvoie son résultat (gardé en BDD) ; elle doit être idempotente. */
export type StepFn = (ctx: StepContext) => Promise<Record<string, unknown>>;

export interface PipelineDeps {
  /** Alertes opérateur (optionnel : absent dans les tests). */
  alerts?: { guild(guildId: string, cause: string, message: string): Promise<void> };
  client: Client;
  repos: Repositories;
  /** Stockage du serveur (copie des fichiers) : absent dans les tests. */
  storage?: StorageService;
  settings: SettingsService;
  config: AppConfig;
  log: Logger;
}

const STATUS_THROTTLE_MS = 3000;

/**
 * Traitement post-réunion, reprenable : chaque étape est enregistrée en BDD. Une réunion à la
 * fois (les GPU de transcription et de résumé sont partagés). Un échec arrête le traitement et
 * propose « Relancer », qui ne refait que l'étape en échec et les suivantes ; un arrêt du bot
 * remet l'étape en cours en attente, reprise au démarrage suivant.
 */
export class PipelineService {
  /** Réunions en attente, par serveur (ordre d'arrivée). */
  private readonly pending = new Map<string, string[]>();
  /** Réunions en cours de mise en file (serveur en cours de lecture en base). */
  private readonly enqueuing = new Set<string>();
  /** Traitements en cours : réunion → serveur. */
  private readonly running = new Map<string, { guildId: string; done: Promise<void> }>();
  /** Dernier serveur servi : le suivant dans l'ordre passe en premier (tour de rôle). */
  private lastGuild: string | null = null;
  /** Réunions à retraiter dès la fin du traitement en cours (nouvel enregistrement entre-temps). */
  private readonly refreshAfterRun = new Set<string>();

  /** Compte rendu publié : la carte (liens) et le post épinglé (derniers comptes rendus) sont mis à jour. */
  private onPublished: (meeting: MeetingRow) => void = () => undefined;
  private readonly abort = new AbortController();
  private stopping = false;

  constructor(
    private readonly deps: PipelineDeps,
    private readonly steps: Record<PipelineStep, StepFn>,
  ) {}

  /**
   * Fin d'un enregistrement : traitement complet, ou mise à jour s'il a déjà eu lieu (audio
   * refait avec toutes les sessions, seuls les nouveaux passages transcrits, compte rendu
   * remplacé). Si la réunion est en cours de traitement, la mise à jour suit immédiatement.
   */
  async refresh(meetingId: string): Promise<void> {
    if (!(await this.hasSpeech(meetingId))) return;
    if (this.running.has(meetingId)) {
      this.refreshAfterRun.add(meetingId);
      return;
    }
    await this.deps.repos.ensurePipeline(meetingId);
    await this.deps.repos.resetSteps(meetingId, [...PIPELINE_STEPS]);
    await this.enqueue(meetingId);
  }

  /**
   * Clôture de la réunion : traite ce qui ne l'a pas encore été (par exemple une session
   * interrompue par une coupure, qui ne déclenche rien pour laisser la place à une reprise).
   */
  async processIfNeeded(meetingId: string): Promise<void> {
    if (this.isQueued(meetingId) || !(await this.hasSpeech(meetingId))) return;
    const mix = (await this.deps.repos.listPipeline(meetingId)).find((r) => r.step === 'mix');
    const lastEnd = Math.max(0, ...(await this.deps.repos.listRecordingsForMeeting(meetingId)).map((r) => r.endedAt?.getTime() ?? 0));
    const covered = mix?.status === 'done' && mix.finishedAt !== null && mix.finishedAt.getTime() >= lastEnd;
    if (!covered) await this.refresh(meetingId);
  }

  /** Quelque chose à traiter : de la parole enregistrée, et un post où publier (pas supprimé à la main). */
  private async hasSpeech(meetingId: string): Promise<boolean> {
    if (!(await this.deps.repos.getMeeting(meetingId))?.threadId) return false;
    return this.deps.repos.hasSpeech(meetingId);
  }

  setOnPublished(fn: (meeting: MeetingRow) => void): void {
    this.onPublished = fn;
  }

  /** Programme le traitement (étapes créées si besoin). */
  async schedule(meetingId: string): Promise<void> {
    await this.deps.repos.ensurePipeline(meetingId);
    await this.enqueue(meetingId);
  }

  /** Relance : les étapes en échec et les suivantes repassent en attente. */
  async retry(meetingId: string): Promise<void> {
    const rows = await this.deps.repos.listPipeline(meetingId);
    const firstFailed = rows.findIndex((r) => r.status === 'failed');
    if (firstFailed >= 0) await this.deps.repos.resetSteps(meetingId, rows.slice(firstFailed).map((r) => r.step));
    await this.enqueue(meetingId);
  }

  /** Nouveau compte rendu : résumé et publication refaits ; la transcription aussi si demandé. */
  async regenerate(meetingId: string, retranscribe: boolean, requestedBy?: string): Promise<void> {
    // Gardé en base : la personne est prévenue à la publication, même après un redémarrage.
    if (requestedBy) await this.deps.repos.addReportRequester(meetingId, requestedBy);
    await this.deps.repos.ensurePipeline(meetingId);
    if (retranscribe) await this.deps.repos.resetTranscription(meetingId);
    await this.deps.repos.resetSteps(meetingId, retranscribe ? [...PIPELINE_STEPS] : ['summarize', 'publish', 'export']);
    await this.enqueue(meetingId);
  }

  isQueued(meetingId: string): boolean {
    return this.running.has(meetingId) || this.enqueuing.has(meetingId) || [...this.pending.values()].some((q) => q.includes(meetingId));
  }

  /** Au démarrage : reprise des traitements interrompus. */
  async resume(): Promise<void> {
    for (const meetingId of await this.deps.repos.listUnfinishedPipelines()) {
      const rows = await this.deps.repos.listPipeline(meetingId);
      const running = rows.filter((r) => r.status === 'running').map((r) => r.step);
      await this.deps.repos.resetSteps(meetingId, running);
      await this.enqueue(meetingId);
    }
    // Clôture juste avant un arrêt du bot : le compte rendu n'avait pas encore été lancé.
    for (const meetingId of await this.deps.repos.listEndedWithoutPipeline()) await this.processIfNeeded(meetingId);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
  }

  /**
   * File par serveur, servie à tour de rôle, avec un plafond global de traitements simultanés
   * (pipeline.maxConcurrent, 1 par défaut : les GPU de transcription et de résumé sont partagés).
   * Un serveur n'attend donc que le traitement en cours, pas toute la file des autres. Une
   * réunion n'est jamais traitée deux fois en même temps, ni deux réunions d'un même serveur.
   */
  private async enqueue(meetingId: string): Promise<void> {
    if (this.stopping || this.isQueued(meetingId)) return;
    // Marquée tout de suite : la recherche du serveur ne doit pas la faire paraître « libre ».
    this.enqueuing.add(meetingId);
    try {
      const meeting = await this.deps.repos.getMeeting(meetingId);
      if (!meeting || this.stopping) return;
      const queue = this.pending.get(meeting.guildId) ?? [];
      queue.push(meetingId);
      this.pending.set(meeting.guildId, queue);
    } finally {
      this.enqueuing.delete(meetingId);
    }
    this.pump();
  }

  /** Lance des traitements tant qu'il reste de la place et un serveur en attente. */
  private pump(): void {
    const max = this.deps.config.pipeline.maxConcurrent;
    while (!this.stopping && this.running.size < max) {
      const busy = new Set([...this.running.values()].map((r) => r.guildId));
      const guilds = [...this.pending.keys()].filter((g) => (this.pending.get(g)?.length ?? 0) > 0 && !busy.has(g));
      if (guilds.length === 0) return;
      // Tour de rôle : le premier serveur après le dernier servi.
      const after = this.lastGuild ? guilds.find((g) => g > this.lastGuild!) : undefined;
      const guildId = after ?? [...guilds].sort()[0]!;
      const meetingId = this.pending.get(guildId)!.shift()!;
      if (this.pending.get(guildId)!.length === 0) this.pending.delete(guildId);
      this.lastGuild = guildId;
      const done = this.process(meetingId).finally(() => {
        this.running.delete(meetingId);
        this.pump();
      });
      this.running.set(meetingId, { guildId, done });
    }
  }

  private async process(meetingId: string): Promise<void> {
    for (;;) {
      try {
        await this.run(meetingId);
      } catch (err) {
        this.deps.log.error({ meetingId, err }, 'Traitement post-réunion en échec');
      }
      // Mise à jour demandée pendant le traitement : elle suit aussitôt, sans que la réunion
      // paraisse « libre » un instant (elle serait doublée).
      if (!this.refreshAfterRun.delete(meetingId) || this.stopping) return;
      await this.deps.repos.resetSteps(meetingId, [...PIPELINE_STEPS]).catch((err) => this.deps.log.error({ meetingId, err }, 'Mise à jour du traitement impossible'));
    }
  }

  private async run(meetingId: string): Promise<void> {
    const { repos, log } = this.deps;
    const meeting = await repos.getMeeting(meetingId);
    if (!meeting) return;
    const settings = await this.deps.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    const details = new Map<PipelineStep, string>();
    const status = new StatusMessage(this.deps, meeting, m);
    const plog = log.child({ meetingId });

    for (const row of await repos.listPipeline(meetingId)) {
      if (row.status === 'done') continue;
      if (this.stopping) return;
      await repos.updateStep(meetingId, row.step, { status: 'running', attempts: row.attempts + 1, startedAt: new Date(), error: null });
      await status.update(details);
      plog.info({ step: row.step }, 'Étape démarrée');
      try {
        const output = await this.steps[row.step]({
          meeting,
          settings,
          m,
          signal: this.abort.signal,
          log: plog.child({ step: row.step }),
          progress: (detail) => {
            details.set(row.step, detail);
            status.schedule(details);
          },
        });
        await repos.updateStep(meetingId, row.step, { status: 'done', finishedAt: new Date(), output });
        plog.info({ step: row.step }, 'Étape terminée');
        // Compte rendu publié : la carte, le post épinglé et les demandeurs n'attendent pas la copie vers le stockage.
        if (row.step === 'publish') {
          this.onPublished(meeting);
          await this.notifyRequesters(meeting, m).catch((e) => plog.warn({ err: errorMessage(e) }, 'Avis de mise à jour impossible'));
        }
      } catch (err) {
        if (this.abort.signal.aborted) {
          await repos.updateStep(meetingId, row.step, { status: 'pending' }); // reprise au redémarrage
          return;
        }
        const message = errorMessage(err);
        plog.error({ step: row.step, err }, 'Étape en échec');
        await repos.updateStep(meetingId, row.step, { status: 'failed', finishedAt: new Date(), error: message });
        details.set(row.step, message);
        await status.update(details);
        // L'organisateur est prévenu (le message de suivi, lui, est silencieux) ; pas pour la copie
        // vers le stockage : le compte rendu est publié, c'est l'affaire des administrateurs (alerte).
        if (row.step !== 'export') await this.notifyFailure(meeting, m).catch((e) => plog.warn({ err: errorMessage(e) }, 'Avis d’échec impossible'));
        const url = meeting.threadId ? `https://discord.com/channels/${meeting.guildId}/${meeting.threadId}` : '';
        await this.deps.alerts
          ?.guild(meeting.guildId, `pipeline:${row.step}`, m.alerts.stepFailed(meeting.title, m.pipeline.steps[row.step] ?? row.step, message.slice(0, 300), url))
          .catch(() => undefined);
        return;
      }
    }
    await status.update(details);
    // Réunion close : plus de nouvelle session possible, le mix sans perte ne sert plus.
    if ((await repos.getMeeting(meetingId))?.status === 'ended') {
      const master = await repos.dropMixMaster(meetingId);
      if (master) await rm(master, { force: true }).catch((err) => plog.warn({ err: errorMessage(err) }, 'Suppression du mix sans perte impossible'));
    }
  }

  private async notifyFailure(meeting: MeetingRow, m: Messages): Promise<void> {
    const thread = await fetchThread(this.deps.client, meeting.threadId);
    if (!thread) return;
    // Ceux qui ont demandé la régénération sont prévenus aussi ; ils le seront de nouveau à la
    // publication réussie (relance).
    const requesters = (await this.deps.repos.getMeeting(meeting.id))?.reportRequesters ?? [];
    const users = [...new Set([meeting.organizerId, ...requesters])];
    await ensureUnarchived(thread);
    await thread.send({ content: m.pipeline.failedNotice(users), allowedMentions: { users } });
  }

  /** Compte rendu publié : ceux qui avaient demandé une correction ou une régénération sont prévenus. */
  private async notifyRequesters(meeting: MeetingRow, m: Messages): Promise<void> {
    const users = await this.deps.repos.takeReportRequesters(meeting.id);
    if (users.length === 0) return;
    const thread = await fetchThread(this.deps.client, meeting.threadId);
    if (!thread) return;
    const publish = (await this.deps.repos.listPipeline(meeting.id)).find((r) => r.step === 'publish');
    const url = typeof publish?.output?.url === 'string' ? publish.output.url : null;
    await ensureUnarchived(thread);
    await thread.send({ content: m.pipeline.updatedNotice(users, url), allowedMentions: { users } });
  }
}

/** Message de suivi dans le post (créé au premier affichage, puis édité ; éditions espacées). */
class StatusMessage {
  private timer: NodeJS.Timeout | null = null;
  private last = 0;

  constructor(
    private readonly deps: PipelineDeps,
    private readonly meeting: MeetingRow,
    private readonly m: Messages,
  ) {}

  schedule(details: Map<PipelineStep, string>): void {
    if (this.timer) return;
    const wait = Math.max(0, STATUS_THROTTLE_MS - (Date.now() - this.last));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.update(details).catch(() => undefined);
    }, wait);
  }

  async update(details: Map<PipelineStep, string>): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.last = Date.now();
    const { repos, client, log } = this.deps;
    const meeting = (await repos.getMeeting(this.meeting.id)) ?? this.meeting;
    // Copie vers le stockage affichée seulement si le serveur en a un (ou si elle a eu lieu).
    const storage = (await this.deps.storage?.get(meeting.guildId).catch(() => undefined)) !== undefined;
    const rows = (await repos.listPipeline(meeting.id)).filter((r) => r.step !== 'export' || (r.status === 'done' ? r.output?.skipped !== true : storage || r.status === 'failed'));
    const views: StepView[] = rows.map((r) => ({
      step: r.step,
      status: r.status,
      detail: r.status === 'failed' ? (r.error ?? details.get(r.step)) : (details.get(r.step) ?? null),
      skipped: r.status === 'done' && r.output?.skipped === true,
    }));
    const publish = rows.find((r) => r.step === 'publish');
    const url = typeof publish?.output?.url === 'string' ? publish.output.url : undefined;
    const container = renderPipelineStatus(meeting.id, views, this.m, url);

    try {
      const thread = await fetchThread(client, meeting.threadId);
      if (!thread) return;
      if (meeting.reportStatusMessageId) {
        const message = await thread.messages.fetch(meeting.reportStatusMessageId).catch(() => null);
        if (message) {
          await ensureUnarchived(thread);
          await message.edit({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
          return;
        }
      }
      await ensureUnarchived(thread);
      const message = await thread.send({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
        allowedMentions: { parse: [] },
      });
      await repos.updateMeeting(meeting.id, { reportStatusMessageId: message.id });
    } catch (err) {
      log.warn({ meetingId: meeting.id, err: errorMessage(err) }, 'Message de suivi du compte rendu impossible');
    }
  }
}
