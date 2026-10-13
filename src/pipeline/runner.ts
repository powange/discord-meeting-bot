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
  private readonly queue: string[] = [];
  /** Réunions à retraiter dès la fin du traitement en cours (nouvel enregistrement entre-temps). */
  private readonly refreshAfterRun = new Set<string>();
  private worker: Promise<void> | null = null;
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
    if (this.queue[0] === meetingId) {
      this.refreshAfterRun.add(meetingId);
      return;
    }
    await this.deps.repos.ensurePipeline(meetingId);
    await this.deps.repos.resetSteps(meetingId, [...PIPELINE_STEPS]);
    this.enqueue(meetingId);
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

  private hasSpeech(meetingId: string): Promise<boolean> {
    return this.deps.repos.hasSpeech(meetingId);
  }

  setOnPublished(fn: (meeting: MeetingRow) => void): void {
    this.onPublished = fn;
  }

  /** Programme le traitement (étapes créées si besoin). */
  async schedule(meetingId: string): Promise<void> {
    await this.deps.repos.ensurePipeline(meetingId);
    this.enqueue(meetingId);
  }

  /** Relance : les étapes en échec et les suivantes repassent en attente. */
  async retry(meetingId: string): Promise<void> {
    const rows = await this.deps.repos.listPipeline(meetingId);
    const firstFailed = rows.findIndex((r) => r.status === 'failed');
    if (firstFailed >= 0) await this.deps.repos.resetSteps(meetingId, rows.slice(firstFailed).map((r) => r.step));
    this.enqueue(meetingId);
  }

  /** Nouveau compte rendu : résumé et publication refaits ; la transcription aussi si demandé. */
  async regenerate(meetingId: string, retranscribe: boolean): Promise<void> {
    await this.deps.repos.ensurePipeline(meetingId);
    if (retranscribe) await this.deps.repos.resetTranscription(meetingId);
    await this.deps.repos.resetSteps(meetingId, retranscribe ? [...PIPELINE_STEPS] : ['summarize', 'publish']);
    this.enqueue(meetingId);
  }

  isQueued(meetingId: string): boolean {
    return this.queue.includes(meetingId);
  }

  /** Au démarrage : reprise des traitements interrompus. */
  async resume(): Promise<void> {
    for (const meetingId of await this.deps.repos.listUnfinishedPipelines()) {
      const rows = await this.deps.repos.listPipeline(meetingId);
      const running = rows.filter((r) => r.status === 'running').map((r) => r.step);
      await this.deps.repos.resetSteps(meetingId, running);
      this.enqueue(meetingId);
    }
    // Clôture juste avant un arrêt du bot : le compte rendu n'avait pas encore été lancé.
    for (const meetingId of await this.deps.repos.listEndedWithoutPipeline()) await this.processIfNeeded(meetingId);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    await this.worker?.catch(() => undefined);
  }

  private enqueue(meetingId: string): void {
    if (this.stopping || this.queue.includes(meetingId)) return;
    this.queue.push(meetingId);
    this.worker ??= this.drain().finally(() => {
      this.worker = null;
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.stopping) {
      const meetingId = this.queue[0]!;
      try {
        await this.run(meetingId);
      } catch (err) {
        this.deps.log.error({ meetingId, err }, 'Traitement post-réunion en échec');
      } finally {
        // Mise à jour demandée pendant le traitement : la réunion reste en tête de file (jamais
        // retirée puis remise, sinon elle paraîtrait « libre » un instant et serait doublée).
        const again = this.refreshAfterRun.delete(meetingId) && !this.stopping;
        if (again) await this.deps.repos.resetSteps(meetingId, [...PIPELINE_STEPS]).catch((err) => this.deps.log.error({ meetingId, err }, 'Mise à jour du traitement impossible'));
        else this.queue.shift();
      }
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
        // L'organisateur est prévenu (le message de suivi, lui, est silencieux).
        await this.notifyFailure(meeting, m).catch((e) => plog.warn({ err: errorMessage(e) }, 'Avis d’échec impossible'));
        const url = meeting.threadId ? `https://discord.com/channels/${meeting.guildId}/${meeting.threadId}` : '';
        await this.deps.alerts
          ?.guild(meeting.guildId, `pipeline:${row.step}`, m.alerts.stepFailed(meeting.title, m.pipeline.steps[row.step] ?? row.step, message.slice(0, 300), url))
          .catch(() => undefined);
        return;
      }
    }
    await status.update(details);
    this.onPublished(meeting);
  }

  private async notifyFailure(meeting: MeetingRow, m: Messages): Promise<void> {
    const thread = await fetchThread(this.deps.client, meeting.threadId);
    if (!thread) return;
    await ensureUnarchived(thread);
    await thread.send({ content: m.pipeline.failedNotice(meeting.organizerId), allowedMentions: { users: [meeting.organizerId] } });
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
    const rows = await repos.listPipeline(meeting.id);
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
