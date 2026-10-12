import { ThreadAutoArchiveDuration, type Client, type Guild, type ThreadChannel } from 'discord.js';
import { DateTime } from 'luxon';
import type { Repositories } from '../db/repositories.js';
import type { GuildSettingsRow, MeetingRow } from '../db/schema.js';
import { applyStatusTag, ensureUnarchived } from '../discord/forum.js';
import { ScheduledEvents, type EventData } from '../discord/scheduledEvent.js';
import { fetchForum, fetchThread } from '../discord/threads.js';
import { canReschedule, threadName } from '../domain/meeting.js';
import { planJobs } from '../domain/reminders.js';
import { discordTimestamp } from '../domain/time.js';
import type { MeetingStatus } from '../domain/types.js';
import { messages, type Messages } from '../i18n/index.js';
import { errorMessage, UserError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { CardService } from './cards.js';
import type { SettingsService } from './settings.js';

export interface MeetingInput {
  title: string;
  description: string;
  startsAt: Date;
  durationMin: number;
  voiceChannelId: string;
}

/**
 * Orchestration des réunions : BDD (source de vérité) puis répercussion sur Discord
 * (post, tags, carte, événement natif). Les échecs Discord secondaires sont loggés sans
 * annuler l'opération ; seule la création du post est transactionnelle.
 */
export class MeetingService {
  private readonly events: ScheduledEvents;

  constructor(
    private readonly client: Client,
    private readonly repos: Repositories,
    private readonly settings: SettingsService,
    private readonly cards: CardService,
    private readonly log: Logger,
  ) {
    this.events = new ScheduledEvents(log);
  }

  async create(guild: Guild, organizerId: string, input: MeetingInput, options: { copyAgendaFrom?: string } = {}): Promise<MeetingRow> {
    const settings = await this.settings.get(guild.id);
    const m = messages(settings.locale);
    const forum = await fetchForum(this.client, settings.forumChannelId);
    if (!forum) throw new UserError(m.errors.forumNotConfigured);
    if (!settings.tagIds) throw new UserError(m.errors.tagsMissing);

    let meeting = await this.repos.insertMeeting({
      guildId: guild.id,
      organizerId,
      autoRecord: settings.autoRecordDefault,
      ...input,
    });
    let thread: ThreadChannel | null = null;
    try {
      if (options.copyAgendaFrom) await this.repos.copyAgenda(options.copyAgendaFrom, meeting.id);
      const card = await this.cards.render(meeting);
      thread = await forum.threads.create({
        name: threadName(input.title, dayMonth(input.startsAt, settings.timezone)),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        appliedTags: [settings.tagIds.upcoming],
        message: { ...card, allowedMentions: { parse: [] } },
        reason: `Réunion créée par ${organizerId}`,
      });
      meeting = (await this.repos.updateMeeting(meeting.id, { threadId: thread.id }))!;
    } catch (err) {
      await this.repos.deleteMeeting(meeting.id);
      await thread?.delete().catch(() => undefined);
      throw err;
    }

    const eventId = await this.events.create(guild, this.eventData(meeting, thread.url, m));
    if (eventId) meeting = (await this.repos.updateMeeting(meeting.id, { scheduledEventId: eventId }))!;
    await this.replan(meeting, settings);
    this.log.info({ guildId: guild.id, meetingId: meeting.id, threadId: thread.id }, 'Réunion créée');
    return meeting;
  }

  async update(guild: Guild, meeting: MeetingRow, input: MeetingInput, by: string): Promise<MeetingRow> {
    const settings = await this.settings.get(guild.id);
    const m = messages(settings.locale);
    const rescheduled =
      input.startsAt.getTime() !== meeting.startsAt.getTime() ||
      input.durationMin !== meeting.durationMin ||
      input.voiceChannelId !== meeting.voiceChannelId;
    if (rescheduled && !canReschedule(meeting.status)) throw new UserError(m.errors.cannotReschedule);

    let updated = (await this.repos.updateMeeting(meeting.id, input))!;
    const thread = await fetchThread(this.client, updated.threadId);
    if (thread) {
      await ensureUnarchived(thread);
      const name = threadName(updated.title, dayMonth(updated.startsAt, settings.timezone));
      if (thread.name !== name) await thread.setName(name).catch((err) => this.warn(updated, 'Renommage du post impossible', err));
      if (input.startsAt.getTime() !== meeting.startsAt.getTime()) {
        await thread.send({ content: m.thread.rescheduled(discordTimestamp(updated.startsAt, 'F')), allowedMentions: { parse: [] } });
      }
    }
    if (updated.status === 'scheduled') {
      const eventId = await this.events.update(guild, updated.scheduledEventId, this.eventData(updated, thread?.url ?? '', m));
      if (eventId !== updated.scheduledEventId) updated = (await this.repos.updateMeeting(updated.id, { scheduledEventId: eventId }))!;
    }
    if (rescheduled) await this.replan(updated, settings);
    await this.cards.refreshNow(updated.id);
    this.log.info({ meetingId: updated.id, by, rescheduled }, 'Réunion modifiée');
    return updated;
  }

  /** Passage « En cours » (heure de début atteinte). */
  async start(meetingId: string): Promise<boolean> {
    const meeting = await this.repos.transitionMeeting(meetingId, ['scheduled'], 'live', { startedAt: new Date() });
    if (!meeting) return false;
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    await this.replan(meeting, settings);
    await this.afterStatusChange(meeting, settings, (thread) =>
      thread.send({ content: m.thread.started(meeting.voiceChannelId), allowedMentions: { parse: [] } }),
    );
    const guild = await this.guild(meeting);
    if (guild) await this.events.start(guild, meeting.scheduledEventId);
    return true;
  }

  /** Clôture (manuelle ou automatique). `by` = null pour une clôture automatique. */
  async end(meetingId: string, by: string | null): Promise<boolean> {
    const meeting = await this.repos.transitionMeeting(meetingId, ['scheduled', 'live'], 'ended', {
      endedAt: new Date(),
      agendaLocked: true,
    });
    if (!meeting) return false;
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    await this.repos.cancelPendingJobs(meeting.id);
    await this.afterStatusChange(meeting, settings, (thread) => thread.send({ content: m.thread.ended(by), allowedMentions: { parse: [] } }));
    const guild = await this.guild(meeting);
    if (guild) await this.events.complete(guild, meeting.scheduledEventId);
    this.log.info({ meetingId, by }, 'Réunion close');
    return true;
  }

  async cancel(meetingId: string, by: string, reason: string | null, options: { silent?: boolean } = {}): Promise<boolean> {
    const meeting = await this.repos.transitionMeeting(meetingId, ['scheduled', 'live'], 'cancelled', { endedAt: new Date() });
    if (!meeting) return false;
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    await this.repos.cancelPendingJobs(meeting.id);
    const guild = await this.guild(meeting);
    if (guild) await this.events.cancel(guild, meeting.scheduledEventId);
    if (!options.silent) {
      await this.afterStatusChange(meeting, settings, async (thread) => {
        await thread.send({ content: m.thread.cancelled(by, reason), allowedMentions: { parse: [] } });
        await thread.setArchived(true, 'Réunion annulée');
      });
    }
    this.log.info({ meetingId, by }, 'Réunion annulée');
    return true;
  }

  /** Post supprimé à la main : la réunion est annulée sans rien publier. */
  async onThreadDeleted(threadId: string): Promise<void> {
    const meeting = await this.repos.getMeetingByThread(threadId);
    if (meeting) await this.cancel(meeting.id, this.client.user?.id ?? 'system', null, { silent: true });
  }

  /** Recalcule les échéances des réunions à venir ou en cours (après un changement des rappels). */
  async replanGuild(guildId: string): Promise<void> {
    const settings = await this.settings.get(guildId);
    for (const meeting of await this.repos.listMeetings(guildId, ['scheduled', 'live'])) await this.replan(meeting, settings);
  }

  // ---------------------------------------------------------------- interne

  private async replan(meeting: MeetingRow, settings: GuildSettingsRow): Promise<void> {
    await this.repos.replaceJobs(meeting.id, planJobs(meeting, settings.reminderOffsetsMin, new Date()));
  }

  /** Carte, tag et message dans le post après un changement de statut. */
  private async afterStatusChange(
    meeting: MeetingRow,
    settings: GuildSettingsRow,
    announce: (thread: ThreadChannel) => Promise<unknown>,
  ): Promise<void> {
    const thread = await fetchThread(this.client, meeting.threadId);
    if (!thread) return;
    await this.cards.refreshNow(meeting.id).catch((err) => this.warn(meeting, 'Mise à jour de la carte impossible', err));
    try {
      await ensureUnarchived(thread);
      if (settings.tagIds) await applyStatusTag(thread, settings.tagIds, meeting.status as MeetingStatus);
    } catch (err) {
      this.warn(meeting, 'Mise à jour du tag impossible', err);
    }
    await announce(thread).catch((err) => this.warn(meeting, 'Message dans le post impossible', err));
  }

  private eventData(meeting: MeetingRow, threadUrl: string, m: Messages): EventData {
    return {
      title: meeting.title,
      description: m.event.description(threadUrl, meeting.description),
      startsAt: meeting.startsAt,
      durationMin: meeting.durationMin,
      voiceChannelId: meeting.voiceChannelId,
    };
  }

  private async guild(meeting: MeetingRow): Promise<Guild | null> {
    return this.client.guilds.fetch(meeting.guildId).catch(() => null);
  }

  private warn(meeting: MeetingRow, msg: string, err: unknown): void {
    this.log.warn({ meetingId: meeting.id, err: errorMessage(err) }, msg);
  }
}

function dayMonth(date: Date, zone: string): string {
  return DateTime.fromJSDate(date, { zone }).toFormat('dd/MM');
}
