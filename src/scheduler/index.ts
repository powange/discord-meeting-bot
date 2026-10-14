import { ActionRowBuilder, type ButtonBuilder } from 'discord.js';
import type { AppContext } from '../context.js';
import type { ScheduledJobRow } from '../db/schema.js';
import { ensureUnarchived } from '../discord/forum.js';
import { fetchThread } from '../discord/threads.js';
import { isReminderStale } from '../domain/reminders.js';
import { nonResponders, nudgeRoles, reminderTargets } from '../domain/rsvp.js';
import { formatWhen } from '../domain/time.js';
import { rsvpButtons } from '../discord/embeds/meetingCard.js';
import { joinVoiceRows, mentionBatches, voiceName } from '../discord/notify.js';
import { messages } from '../i18n/index.js';
import { errorMessage } from '../lib/errors.js';

const BATCH = 20;
const MAX_ATTEMPTS = 5;

/**
 * Scheduler interne : un tick périodique lit en BDD les échéances dues. Rien n'est gardé en
 * mémoire, donc un redémarrage ne perd aucun rappel (les échéances manquées sont rattrapées
 * au tick suivant, sauf les rappels devenus inutiles).
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** Dernier passage terminé (exposé par /health). */
  lastTickAt: Date | null = null;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    // setInterval plutôt qu'une expression cron : « */45 » dans le champ des secondes ne donne pas
    // une période de 45 s. tick() ignore un passage si le précédent n'est pas fini.
    this.timer = setInterval(() => void this.tick(), this.ctx.config.scheduler.tickSeconds * 1000);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runDue()
      .catch((err) => this.ctx.log.error({ err }, 'Tick du scheduler en échec'))
      .finally(() => {
        this.running = null;
        this.lastTickAt = new Date();
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
        await this.ctx.meetings.ensureVoice(job.meetingId);
        await this.ctx.recordings.autoStart(job.meetingId);
        return;
      case 'voice_create':
        await this.ctx.meetings.ensureVoice(job.meetingId);
        return;
      case 'poll_nudge':
        await this.ctx.meetings.nudgePoll(job.meetingId);
        return;
      case 'poll_close':
        await this.ctx.meetings.closePoll(job.meetingId);
        return;
      case 'auto_end':
        // Ancienne clôture à heure fixe : remplacée par la clôture sur vocal vide (MeetingWatcher).
        return;
    }
  }

  private async sendReminder(job: ScheduledJobRow, now: Date): Promise<void> {
    let meeting = await this.ctx.repos.getMeeting(job.meetingId);
    if (!meeting || meeting.status !== 'scheduled' || isReminderStale(meeting.startsAt, now)) return;
    const settings = await this.ctx.settings.get(meeting.guildId);
    // Rappel tombant avec (ou après) la création du salon temporaire : le salon d'abord, pour le bouton « Rejoindre ».
    if (!meeting.voiceChannelId && meeting.startsAt.getTime() - now.getTime() <= settings.autoVoiceLeadMin * 60_000) {
      meeting = (await this.ctx.meetings.ensureVoice(meeting.id)) ?? meeting;
    }
    const thread = await fetchThread(this.ctx.client, meeting.threadId);
    if (!thread) return;

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

    const roleIds = nudgeRoles(meeting, settings);
    // Relance à chaque rappel : les membres des rôles invités (ou du rôle de relance) qui n'ont
    // toujours pas répondu sont mentionnés un par un.
    if (roleIds.length) {
      // La relance est un plus : son échec (intent GuildMembers absent, délai) ne doit pas
      // empêcher le rappel lui-même.
      try {
        const guild = await this.ctx.client.guilds.fetch(meeting.guildId);
        await guild.members.fetch(); // nécessite l'intent privilégié GuildMembers
        const expected = roleIds.flatMap((id) => [...(guild.roles.cache.get(id)?.members.filter((mb) => !mb.user.bot).keys() ?? [])]);
        const missing = nonResponders(expected, rsvps, [meeting.organizerId]);
        if (missing.length > 0) batches.push(...mentionBatches(`${m.thread.nudge} `, missing));
      } catch (err) {
        this.ctx.log.warn({ meetingId: meeting.id, err: errorMessage(err) }, 'Relance des non-répondants impossible');
      }
    }

    await ensureUnarchived(thread);
    for (const [i, batch] of batches.entries()) {
      const send = thread.send({
        content: batch.content,
        allowedMentions: { users: batch.users },
        // Répondre sans remonter jusqu'à la carte (mobile), et rejoindre le vocal s'il existe.
        ...(i === 0 ? { components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...rsvpButtons(meeting.id, m)).toJSON(), ...joinVoiceRows(meeting.guildId, meeting.voiceChannelId, m)] } : {}),
      });
      // Le premier message est le rappel : son échec fait réessayer l'échéance. Les suivants
      // (mentions en surplus) ne la font pas réessayer, sinon le premier partirait deux fois.
      if (i === 0) await send;
      else await send.catch((err) => this.ctx.log.warn({ meetingId: meeting.id, err: errorMessage(err) }, 'Lot de mentions non envoyé'));
    }
  }
}
