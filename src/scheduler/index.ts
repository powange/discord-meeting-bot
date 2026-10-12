import { schedule, type ScheduledTask } from 'node-cron';
import type { AppContext } from '../context.js';
import type { ScheduledJobRow } from '../db/schema.js';
import { ensureUnarchived } from '../discord/forum.js';
import { fetchThread } from '../discord/threads.js';
import { isNudgeReminder, isReminderStale } from '../domain/reminders.js';
import { nonResponders, reminderTargets } from '../domain/rsvp.js';
import { formatWhen } from '../domain/time.js';
import { joinVoiceRow, mentionBatches, voiceName } from '../discord/notify.js';
import { messages } from '../i18n/index.js';
import { errorMessage } from '../lib/errors.js';

const BATCH = 20;
const MAX_ATTEMPTS = 5;

/**
 * Scheduler interne : un tick node-cron lit en BDD les échéances dues. Rien n'est gardé en
 * mémoire, donc un redémarrage ne perd aucun rappel (les échéances manquées sont rattrapées
 * au tick suivant, sauf les rappels devenus inutiles).
 */
export class Scheduler {
  private task: ScheduledTask | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    const every = this.ctx.config.scheduler.tickSeconds;
    this.task = schedule(`*/${every} * * * * *`, () => this.tick(), { name: 'scheduled-jobs', noOverlap: true });
    void this.tick();
  }

  async stop(): Promise<void> {
    await this.task?.stop();
    await this.running;
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runDue()
      .catch((err) => this.ctx.log.error({ err }, 'Tick du scheduler en échec'))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async runDue(): Promise<void> {
    const now = new Date();
    const jobs = await this.ctx.repos.claimDueJobs(now, BATCH, MAX_ATTEMPTS);
    for (const job of jobs) {
      const log = this.ctx.log.child({ jobId: job.id, kind: job.kind, meetingId: job.meetingId });
      try {
        await this.run(job, now);
        await this.ctx.repos.completeJob(job.id);
        log.debug('Échéance exécutée');
      } catch (err) {
        await this.ctx.repos.failJob(job, errorMessage(err), new Date());
        log.error({ err, attempt: job.attempts }, 'Échéance en échec');
      }
    }
  }

  private async run(job: ScheduledJobRow, now: Date): Promise<void> {
    switch (job.kind) {
      case 'reminder':
        return this.sendReminder(job, now);
      case 'start':
        await this.ctx.meetings.start(job.meetingId);
        return;
      case 'record_start':
        await this.ctx.recordings.autoStart(job.meetingId);
        return;
      case 'auto_end':
        // Ancienne clôture à heure fixe : remplacée par la clôture sur vocal vide (MeetingWatcher).
        return;
    }
  }

  private async sendReminder(job: ScheduledJobRow, now: Date): Promise<void> {
    const meeting = await this.ctx.repos.getMeeting(job.meetingId);
    if (!meeting || meeting.status !== 'scheduled' || isReminderStale(meeting.startsAt, now)) return;
    const thread = await fetchThread(this.ctx.client, meeting.threadId);
    if (!thread) return;

    const settings = await this.ctx.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    const rsvps = await this.ctx.repos.listRsvps(meeting.id);

    // Première ligne lisible telle quelle dans une notification push ; mentions sur la ligne suivante.
    const minutesLeft = Math.round((meeting.startsAt.getTime() - now.getTime()) / 60_000);
    const intro = m.thread.reminder(
      meeting.title,
      m.format.startsIn(minutesLeft),
      formatWhen(meeting.startsAt, settings.timezone, settings.locale, m.format.when),
      await voiceName(this.ctx.client, meeting.voiceChannelId, m),
    );
    const targets = reminderTargets(rsvps);
    const batches: Array<{ content: string; users: string[] }> = [];
    batches.push(...mentionBatches(targets.length > 0 ? `${intro}\n${m.thread.reminderTargets} ` : intro, targets));

    if (settings.nudgeRoleId && isNudgeReminder(job.offsetMin, settings.reminderOffsetsMin)) {
      const guild = await this.ctx.client.guilds.fetch(meeting.guildId);
      await guild.members.fetch(); // nécessite l'intent privilégié GuildMembers
      const role = guild.roles.cache.get(settings.nudgeRoleId);
      const expected = role ? [...role.members.filter((mb) => !mb.user.bot).keys()] : [];
      const missing = nonResponders(expected, rsvps, [meeting.organizerId]);
      if (missing.length > 0) batches.push(...mentionBatches(`${m.thread.nudge} `, missing));
    }

    await ensureUnarchived(thread);
    for (const [i, batch] of batches.entries()) {
      await thread.send({
        content: batch.content,
        allowedMentions: { users: batch.users },
        ...(i === 0 ? { components: [joinVoiceRow(meeting.guildId, meeting.voiceChannelId, m)] } : {}),
      });
    }
  }
}
