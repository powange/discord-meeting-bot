import { ActionRowBuilder, type ButtonBuilder, type MessageMentionOptions } from 'discord.js';
import type { AppContext } from '../context.js';
import type { ScheduledJobRow } from '../db/schema.js';
import { ensureUnarchived } from '../discord/forum.js';
import { fetchThread } from '../discord/threads.js';
import { isReminderStale } from '../domain/reminders.js';
import { nonResponders, nudgeRoles, reminderTargets } from '../domain/rsvp.js';
import { formatWhen } from '../domain/time.js';
import { rsvpButtons } from '../discord/embeds/meetingCard.js';
import { loadMembers } from '../discord/members.js';
import { joinVoiceRows, mentionBatches, nudgeMessages, pingableRoles, voiceName } from '../discord/notify.js';
import { messages } from '../i18n/index.js';
import { errorMessage } from '../lib/errors.js';

const BATCH = 20;
const MAX_ATTEMPTS = 5;
/** Réunions traitées en même temps par un passage (les échéances d'une même réunion restent dans l'ordre). */
const PARALLEL_MEETINGS = 4;

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

  /** Salon d'alertes du serveur (échéance abandonnée). */
  private alert: (guildId: string, cause: string, message: string) => Promise<unknown> = async () => undefined;

  setAlert(alert: (guildId: string, cause: string, message: string) => Promise<unknown>): void {
    this.alert = alert;
  }

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
    const jobs = await this.ctx.repos.claimDueJobs(new Date(), BATCH, MAX_ATTEMPTS);
    // Par réunion, dans l'ordre ; plusieurs réunions en parallèle : un démarrage qui attend la
    // connexion vocale ne retarde pas le rappel d'une autre réunion.
    const byMeeting = new Map<string, ScheduledJobRow[]>();
    for (const job of jobs) byMeeting.set(job.meetingId, [...(byMeeting.get(job.meetingId) ?? []), job]);
    const queue = [...byMeeting.values()];
    const worker = async () => {
      for (let group = queue.shift(); group; group = queue.shift()) await this.runMeetingJobs(group);
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_MEETINGS, queue.length) }, worker));
  }

  private async runMeetingJobs(jobs: readonly ScheduledJobRow[]): Promise<void> {
    // Rappels dus ensemble (bot éteint pendant J-1 et H-15) : seul le plus proche du début part.
    const reminders = jobs.filter((j) => j.kind === 'reminder');
    const closest = Math.min(...reminders.map((j) => j.offsetMin));
    for (const job of jobs) {
      const log = this.ctx.log.child({ jobId: job.id, kind: job.kind, meetingId: job.meetingId });
      try {
        if (job.kind === 'reminder' && job.offsetMin > closest) log.info('Rappel dépassé par un rappel plus proche : ignoré');
        else await this.run(job, new Date()); // heure prise au moment de l'exécution, pas de la réservation
        await this.ctx.repos.completeJob(job.id);
        log.debug('Échéance exécutée');
      } catch (err) {
        await this.ctx.repos.failJob(job, errorMessage(err), new Date());
        log.error({ err, attempt: job.attempts }, 'Échéance en échec');
        // Dernière tentative : plus rien ne la reprendra, les administrateurs sont prévenus.
        if (job.attempts >= MAX_ATTEMPTS) await this.alertAbandoned(job, errorMessage(err)).catch(() => undefined);
      }
    }
  }

  private async alertAbandoned(job: ScheduledJobRow, error: string): Promise<void> {
    const meeting = await this.ctx.repos.getMeeting(job.meetingId);
    if (!meeting) return;
    const m = await this.ctx.settings.messages(meeting.guildId);
    const url = meeting.threadId ? `https://discord.com/channels/${meeting.guildId}/${meeting.threadId}` : '';
    await this.alert(meeting.guildId, `job:${job.kind}`, m.alerts.jobAbandoned(meeting.title, m.alerts.jobKinds[job.kind] ?? job.kind, error.slice(0, 300), url));
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
      case 'poll_remind':
        await this.ctx.meetings.remindPoll(job.meetingId);
        return;
      case 'poll_expire':
        await this.ctx.meetings.expirePoll(job.meetingId);
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
    // Un salon impossible à créer (permission) ne doit pas empêcher le rappel : il part sans
    // bouton « Rejoindre » (l'organisateur est déjà prévenu de l'échec du salon).
    if (!meeting.voiceChannelId && meeting.startsAt.getTime() - now.getTime() <= settings.autoVoiceLeadMin * 60_000) {
      const current = meeting;
      meeting =
        (await this.ctx.meetings.ensureVoice(meeting.id).catch((err) => {
          this.ctx.log.warn({ meetingId: current.id, err: errorMessage(err) }, 'Salon vocal non créé : rappel sans bouton Rejoindre');
          return null;
        })) ?? meeting;
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
    const batches: Array<{ content: string; allowedMentions: MessageMentionOptions }> = [];
    batches.push(
      ...mentionBatches(targets.length > 0 ? `${intro}\n${m.thread.reminderTargets} ` : intro, targets).map((b) => ({ content: b.content, allowedMentions: { users: b.users } })),
    );

    const roleIds = nudgeRoles(meeting, settings);
    // Relance à chaque rappel : les membres des rôles invités (ou du rôle de relance) qui n'ont
    // toujours pas répondu sont mentionnés un par un.
    if (roleIds.length) {
      // La relance est un plus : son échec (intent GuildMembers absent, délai) ne doit pas
      // empêcher le rappel lui-même.
      try {
        const guild = await this.ctx.client.guilds.fetch(meeting.guildId);
        await loadMembers(guild); // nécessite l'intent privilégié GuildMembers
        const expected = roleIds.flatMap((id) => [...(guild.roles.cache.get(id)?.members.filter((mb) => !mb.user.bot).keys() ?? [])]);
        const missing = nonResponders(expected, rsvps, [meeting.organizerId]);
        if (missing.length > 0) batches.push(...nudgeMessages(`${m.thread.nudge} `, missing, { guildId: guild.id, pingable: pingableRoles(guild, roleIds) }, m));
      } catch (err) {
        this.ctx.log.warn({ meetingId: meeting.id, err: errorMessage(err) }, 'Relance des non-répondants impossible');
      }
    }

    await ensureUnarchived(thread);
    for (const [i, batch] of batches.entries()) {
      const send = thread.send({
        content: batch.content,
        allowedMentions: batch.allowedMentions,
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
