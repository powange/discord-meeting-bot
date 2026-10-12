import { ChannelType, MessageFlags, ThreadAutoArchiveDuration, type Client, type Guild, type ThreadChannel } from 'discord.js';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import type { GuildSettingsRow, MeetingRow } from '../db/schema.js';
import { applyStatusTag, ensureUnarchived } from '../discord/forum.js';
import { ScheduledEvents, type EventData } from '../discord/scheduledEvent.js';
import { fetchForum, fetchThread } from '../discord/threads.js';
import { canReschedule, isOpen, threadName } from '../domain/meeting.js';
import { planJobs } from '../domain/reminders.js';
import { formatWhen } from '../domain/time.js';
import { displayName, joinVoiceRows, sendWithMentions, voiceName } from '../discord/notify.js';
import { reminderTargets } from '../domain/rsvp.js';
import type { MeetingStatus } from '../domain/types.js';
import { messages, type Messages } from '../i18n/index.js';
import { errorMessage, UserError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { truncate } from '../lib/text.js';
import type { CardService } from './cards.js';
import type { SettingsService } from './settings.js';

export interface MeetingHooks {
  /** Réunion passée « En cours » (démarrage auto de l'enregistrement). */
  afterStart(meeting: MeetingRow): Promise<unknown>;
  /** Avant clôture ou annulation (arrêt de l'enregistrement, bilan avant le message de fin). */
  beforeClose(meetingId: string): Promise<unknown>;
  /** Après la clôture (pas l'annulation) : lancement du compte rendu. */
  afterEnd(meetingId: string): Promise<unknown>;
}

export interface MeetingInput {
  title: string;
  description: string;
  startsAt: Date;
  durationMin: number;
  /** Null en mode « salon créé automatiquement » : il est créé peu avant le début. */
  voiceChannelId: string | null;
}

/**
 * Orchestration des réunions : BDD (source de vérité) puis répercussion sur Discord
 * (post, tags, carte, événement natif). Les échecs Discord secondaires sont loggés sans
 * annuler l'opération ; seule la création du post est transactionnelle.
 */
export class MeetingService {
  private readonly events: ScheduledEvents;
  /** Créations de salon temporaire en cours (rappel, début et enregistrement peuvent la demander ensemble). */
  private readonly creatingVoice = new Map<string, Promise<MeetingRow | undefined>>();
  /** Branchements de l'enregistrement (phase 2), renseignés au démarrage. */
  hooks: MeetingHooks = { afterStart: async () => undefined, beforeClose: async () => undefined, afterEnd: async () => undefined };

  constructor(
    private readonly config: AppConfig,
    private readonly client: Client,
    private readonly repos: Repositories,
    private readonly settings: SettingsService,
    private readonly cards: CardService,
    private readonly log: Logger,
    /** Appelé après tout changement visible dans la liste des réunions (post épinglé). */
    private readonly onChange: (guildId: string) => void = () => undefined,
  ) {
    this.events = new ScheduledEvents(log);
  }

  async create(guild: Guild, organizerId: string, input: MeetingInput, options: { copyAgendaFrom?: string } = {}): Promise<MeetingRow> {
    const settings = await this.settings.get(guild.id);
    const m = messages(settings.locale);
    const forum = await fetchForum(this.client, settings.forumChannelId);
    if (!forum) throw new UserError(m.errors.forumNotConfigured);
    if (!settings.tagIds) throw new UserError(m.errors.tagsMissing);
    input = await this.applyVoiceMode(settings, input, m);

    let meeting = await this.repos.insertMeeting({
      guildId: guild.id,
      organizerId,
      autoRecord: settings.autoRecordDefault,
      ...input,
    });
    let thread: ThreadChannel | null = null;
    try {
      if (options.copyAgendaFrom) await this.repos.copyAgenda(options.copyAgendaFrom, meeting.id);
      const card = await this.cards.renderCard(meeting);
      thread = await forum.threads.create({
        name: threadName(input.title, input.startsAt, settings.timezone, settings.locale),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        appliedTags: [settings.tagIds.upcoming],
        message: { ...card, allowedMentions: { parse: [] } },
        reason: `Réunion créée par ${organizerId}`,
      });
      const agenda = await thread.send({
        ...(await this.cards.renderAgenda(meeting)),
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressNotifications,
      });
      meeting = (await this.repos.updateMeeting(meeting.id, { threadId: thread.id, agendaMessageId: agenda.id }))!;
    } catch (err) {
      await this.repos.deleteMeeting(meeting.id);
      await thread?.delete().catch(() => undefined);
      throw err;
    }

    const eventId = await this.events.create(guild, this.eventData(meeting, thread.url, m, settings));
    if (eventId) meeting = (await this.repos.updateMeeting(meeting.id, { scheduledEventId: eventId }))!;
    await this.replan(meeting, settings);
    this.onChange(guild.id);
    this.log.info({ guildId: guild.id, meetingId: meeting.id, threadId: thread.id }, 'Réunion créée');
    return meeting;
  }

  async update(guild: Guild, meeting: MeetingRow, input: MeetingInput, by: string): Promise<MeetingRow> {
    const settings = await this.settings.get(guild.id);
    const m = messages(settings.locale);
    if (canReschedule(meeting.status)) input = await this.applyVoiceMode(settings, input, m, meeting);
    const rescheduled =
      input.startsAt.getTime() !== meeting.startsAt.getTime() ||
      input.durationMin !== meeting.durationMin ||
      input.voiceChannelId !== meeting.voiceChannelId;
    if (rescheduled && !canReschedule(meeting.status)) throw new UserError(m.errors.cannotReschedule);

    let updated = (await this.repos.updateMeeting(meeting.id, input))!;
    const thread = await fetchThread(this.client, updated.threadId);
    if (thread) {
      await ensureUnarchived(thread);
      const name = threadName(updated.title, updated.startsAt, settings.timezone, settings.locale);
      if (thread.name !== name) await thread.setName(name).catch((err) => this.warn(updated, 'Renommage du post impossible', err));
      if (input.startsAt.getTime() !== meeting.startsAt.getTime()) {
        const when = formatWhen(updated.startsAt, settings.timezone, settings.locale, m.format.when);
        const startsIn = m.format.startsIn(Math.round((updated.startsAt.getTime() - Date.now()) / 60_000));
        // Tous ceux qui ont répondu sont prévenus, y compris les absents (la nouvelle date leur convient peut-être).
        // Ce message tient lieu des rappels qu'un avancement de l'heure aurait fait sauter.
        const responders = (await this.repos.listRsvps(updated.id)).map((r) => r.userId);
        await sendWithMentions(thread, m.thread.rescheduled(updated.title, when, startsIn), m.thread.responders, responders);
      }
    }
    if (updated.status === 'scheduled') {
      const eventId = await this.events.update(guild, updated.scheduledEventId, this.eventData(updated, thread?.url ?? '', m, settings));
      if (eventId !== updated.scheduledEventId) updated = (await this.repos.updateMeeting(updated.id, { scheduledEventId: eventId }))!;
    }
    if (rescheduled) await this.replan(updated, settings);
    await this.cards.refreshNow(updated.id);
    this.onChange(updated.guildId);
    this.log.info({ meetingId: updated.id, by, rescheduled }, 'Réunion modifiée');
    return updated;
  }

  /** Passage « En cours » (heure de début atteinte). */
  async start(meetingId: string): Promise<boolean> {
    await this.ensureVoice(meetingId).catch((err) => this.log.warn({ meetingId, err: errorMessage(err) }, 'Création du salon vocal impossible'));
    const meeting = await this.repos.transitionMeeting(meetingId, ['scheduled'], 'live', { startedAt: new Date() });
    if (!meeting) return false;
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    await this.replan(meeting, settings);
    const voice = await voiceName(this.client, meeting.voiceChannelId, m);
    const attendees = reminderTargets(await this.repos.listRsvps(meeting.id));
    await this.afterStatusChange(meeting, settings, (thread) =>
      sendWithMentions(thread, m.thread.started(meeting.title, voice), m.thread.reminderTargets, attendees, joinVoiceRows(meeting.guildId, meeting.voiceChannelId, m)),
    );
    const guild = await this.guild(meeting);
    if (guild) await this.events.start(guild, meeting.scheduledEventId);
    this.onChange(meeting.guildId);
    await this.hooks.afterStart(meeting).catch((err) => this.warn(meeting, 'Démarrage auto de l’enregistrement impossible', err));
    return true;
  }

  /** Clôture (manuelle ou automatique). `by` = null pour une clôture automatique. */
  async end(meetingId: string, by: string | null): Promise<boolean> {
    const meeting = await this.repos.transitionMeeting(meetingId, ['scheduled', 'live'], 'ended', {
      endedAt: new Date(),
      agendaLocked: true,
    });
    if (!meeting) return false;
    await this.hooks.beforeClose(meeting.id).catch((err) => this.warn(meeting, 'Arrêt de l’enregistrement impossible', err));
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    await this.repos.cancelPendingJobs(meeting.id);
    const byName = by ? ((await displayName(this.client, meeting.guildId, by)) ?? null) : null;
    await this.afterStatusChange(meeting, settings, (thread) =>
      thread.send({ content: m.thread.ended(byName), allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications }),
    );
    const guild = await this.guild(meeting);
    if (guild) await this.events.complete(guild, meeting.scheduledEventId);
    this.onChange(meeting.guildId);
    this.log.info({ meetingId, by }, 'Réunion close');
    await this.hooks.afterEnd(meeting.id).catch((err) => this.warn(meeting, 'Lancement du compte rendu impossible', err));
    return true;
  }

  async cancel(meetingId: string, by: string, reason: string | null, options: { silent?: boolean } = {}): Promise<boolean> {
    const meeting = await this.repos.transitionMeeting(meetingId, ['scheduled', 'live'], 'cancelled', { endedAt: new Date() });
    if (!meeting) return false;
    await this.hooks.beforeClose(meeting.id).catch((err) => this.warn(meeting, 'Arrêt de l’enregistrement impossible', err));
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    await this.repos.cancelPendingJobs(meeting.id);
    const guild = await this.guild(meeting);
    if (guild) await this.events.cancel(guild, meeting.scheduledEventId);
    if (!options.silent) {
      await this.afterStatusChange(meeting, settings, async (thread) => {
        const byName = await displayName(this.client, meeting.guildId, by);
        await thread.send({ content: m.thread.cancelled(meeting.title, byName, reason), allowedMentions: { parse: [] } });
        await thread.setArchived(true, 'Réunion annulée');
      });
    }
    this.onChange(meeting.guildId);
    this.log.info({ meetingId, by }, 'Réunion annulée');
    return true;
  }

  /** Post supprimé à la main : la réunion est annulée sans rien publier. */
  async onThreadDeleted(threadId: string): Promise<void> {
    const meeting = await this.repos.getMeetingByThread(threadId);
    if (meeting) await this.cancel(meeting.id, this.client.user?.id ?? 'system', null, { silent: true });
  }

  /** Active ou désactive l'enregistrement automatique d'une réunion. */
  async setAutoRecord(meetingId: string, autoRecord: boolean): Promise<void> {
    const meeting = await this.repos.updateMeeting(meetingId, { autoRecord });
    if (!meeting) return;
    await this.replan(meeting, await this.settings.get(meeting.guildId));
    this.cards.refresh(meetingId, ['card']);
  }

  /** Recalcule les échéances des réunions à venir ou en cours (après un changement des rappels). */
  async replanGuild(guildId: string): Promise<void> {
    const settings = await this.settings.get(guildId);
    for (const meeting of await this.repos.listMeetings(guildId, ['scheduled', 'live'])) await this.replan(meeting, settings);
  }

  /**
   * Salon vocal d'une réunion qui n'en a pas encore (mode « créé automatiquement ») : il est créé
   * dans la catégorie choisie (à défaut celle du forum). Recréé s'il a été supprimé à la main avant
   * la fin. Sans effet si la réunion a déjà son salon ou est terminée.
   */
  async ensureVoice(meetingId: string): Promise<MeetingRow | undefined> {
    const pending = this.creatingVoice.get(meetingId);
    if (pending) return pending;
    const task = this.doEnsureVoice(meetingId).finally(() => this.creatingVoice.delete(meetingId));
    this.creatingVoice.set(meetingId, task);
    return task;
  }

  /** Supprime le salon temporaire d'une réunion finie, une fois vide. Renvoie vrai si c'est fait. */
  async deleteTemporaryVoice(meeting: MeetingRow): Promise<boolean> {
    if (!meeting.voiceTemporary || meeting.voiceDeletedAt || isOpen(meeting.status)) return false;
    const channel = meeting.voiceChannelId ? await this.client.channels.fetch(meeting.voiceChannelId).catch(() => null) : null;
    if (channel?.isVoiceBased()) {
      if (channel.members.filter((mb) => !mb.user.bot).size > 0) return false;
      // En cas d'échec (permission retirée…), on n'insiste pas : la surveillance réessaierait toutes les 30 s.
      await channel.delete(`Fin de la réunion « ${meeting.title} »`).catch((err) => this.warn(meeting, 'Suppression du salon temporaire impossible', err));
    }
    await this.repos.updateMeeting(meeting.id, { voiceDeletedAt: new Date() });
    this.cards.refresh(meeting.id, ['card']);
    this.log.info({ meetingId: meeting.id, channelId: meeting.voiceChannelId }, 'Salon vocal temporaire supprimé');
    return true;
  }

  // ---------------------------------------------------------------- interne

  private async doEnsureVoice(meetingId: string): Promise<MeetingRow | undefined> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting || !isOpen(meeting.status)) return meeting;
    if (meeting.voiceChannelId) {
      if (!meeting.voiceTemporary) return meeting;
      if (await this.client.channels.fetch(meeting.voiceChannelId).catch(() => null)) return meeting;
    }
    const guild = await this.guild(meeting);
    if (!guild) return meeting;
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    const parent = settings.autoVoiceCategoryId ?? (await fetchForum(this.client, settings.forumChannelId))?.parentId ?? null;
    const create = (withParent: boolean) =>
      guild.channels.create({
        name: truncate(meeting.title, 100),
        type: ChannelType.GuildVoice,
        ...(withParent && parent ? { parent } : {}),
        reason: `Réunion « ${meeting.title} »`,
      });
    // Catégorie supprimée ou interdite au bot : le salon est créé hors catégorie plutôt que pas du tout.
    const channel = await create(true).catch((err) => {
      if (!parent) throw err;
      this.warn(meeting, 'Création du salon dans la catégorie impossible', err);
      return create(false);
    });
    let updated = (await this.repos.updateMeeting(meeting.id, { voiceChannelId: channel.id, voiceTemporary: true, voiceDeletedAt: null }))!;
    if (updated.status === 'scheduled') {
      const thread = await fetchThread(this.client, updated.threadId);
      const eventId = await this.events.update(guild, updated.scheduledEventId, this.eventData(updated, thread?.url ?? '', m, settings));
      if (eventId !== updated.scheduledEventId) updated = (await this.repos.updateMeeting(updated.id, { scheduledEventId: eventId }))!;
    }
    await this.cards.refreshNow(updated.id).catch((err) => this.warn(updated, 'Mise à jour de la carte impossible', err));
    this.log.info({ meetingId: updated.id, channelId: channel.id }, 'Salon vocal temporaire créé');
    return updated;
  }

  /**
   * Salon imposé par /config : il remplace celui saisi, et doit toujours exister. En mode « créé
   * automatiquement », la réunion garde le salon déjà créé, sinon elle n'en a pas encore.
   */
  private async applyVoiceMode(settings: GuildSettingsRow, input: MeetingInput, m: Messages, current?: MeetingRow): Promise<MeetingInput> {
    if (settings.autoVoice) return { ...input, voiceChannelId: current?.voiceChannelId ?? null };
    if (!settings.voiceChannelId) {
      if (!input.voiceChannelId) throw new UserError(m.errors.voiceRequired);
      return input;
    }
    const channel = await this.client.channels.fetch(settings.voiceChannelId).catch(() => null);
    if (!channel?.isVoiceBased()) throw new UserError(m.errors.fixedVoiceMissing);
    return { ...input, voiceChannelId: settings.voiceChannelId };
  }

  private async replan(meeting: MeetingRow, settings: GuildSettingsRow): Promise<void> {
    const lead = this.config.guild(meeting.guildId).recording.autoJoinLeadMin;
    await this.repos.replaceJobs(meeting.id, planJobs(meeting, settings.reminderOffsetsMin, new Date(), lead, settings.autoVoiceLeadMin));
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

  private eventData(meeting: MeetingRow, threadUrl: string, m: Messages, settings: GuildSettingsRow): EventData {
    return {
      title: meeting.title,
      description: m.event.description(threadUrl, meeting.description),
      startsAt: meeting.startsAt,
      durationMin: meeting.durationMin,
      voiceChannelId: meeting.voiceChannelId,
      location: m.event.voiceLater(settings.autoVoiceLeadMin),
    };
  }

  private async guild(meeting: MeetingRow): Promise<Guild | null> {
    return this.client.guilds.fetch(meeting.guildId).catch(() => null);
  }

  private warn(meeting: MeetingRow, msg: string, err: unknown): void {
    this.log.warn({ meetingId: meeting.id, err: errorMessage(err) }, msg);
  }
}

