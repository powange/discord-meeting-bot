import { MessageFlags, type Client, type ThreadChannel } from 'discord.js';
import type { Repositories } from '../db/repositories.js';
import type { MeetingRow } from '../db/schema.js';
import { ensureUnarchived } from '../discord/forum.js';
import { renderAgendaMessage, renderMeetingCard, type RenderedMessage } from '../discord/embeds/meetingCard.js';
import { fetchThread, isUnknownMessage } from '../discord/threads.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { SettingsService } from './settings.js';

const DEBOUNCE_MS = 1000;

/** Les deux messages d'un post de réunion : la carte (infos + présences) et l'ordre du jour. */
export type CardPart = 'card' | 'agenda';
const ALL: readonly CardPart[] = ['card', 'agenda'];

/**
 * Met à jour les messages d'un post de réunion. Les demandes sont regroupées (debounce) pour
 * absorber les rafales de clics, et sérialisées par réunion pour qu'une édition lente ne
 * soit jamais écrasée par une plus ancienne. Seuls les messages concernés sont édités.
 */
export class CardService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pending = new Map<string, Set<CardPart>>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly client: Client,
    private readonly repos: Repositories,
    private readonly settings: SettingsService,
    private readonly log: Logger,
  ) {}

  async renderCard(meeting: MeetingRow): Promise<RenderedMessage> {
    const [rsvps, m, recording] = await Promise.all([
      this.repos.listRsvps(meeting.id),
      this.settings.messages(meeting.guildId),
      this.repos.getActiveRecording(meeting.id),
    ]);
    return renderMeetingCard(meeting, rsvps, m, recording?.startedAt ?? null);
  }

  async renderAgenda(meeting: MeetingRow): Promise<RenderedMessage> {
    const [agenda, m] = await Promise.all([this.repos.listAgenda(meeting.id), this.settings.messages(meeting.guildId)]);
    return renderAgendaMessage(meeting, agenda, m);
  }

  /** Mise à jour différée (regroupée) des messages `parts`. */
  refresh(meetingId: string, parts: readonly CardPart[] = ALL): void {
    const set = this.pending.get(meetingId) ?? new Set<CardPart>();
    for (const p of parts) set.add(p);
    this.pending.set(meetingId, set);
    clearTimeout(this.timers.get(meetingId));
    this.timers.set(
      meetingId,
      setTimeout(() => {
        this.refreshNow(meetingId, []).catch((err) => this.log.error({ meetingId, err }, 'Mise à jour de la réunion échouée'));
      }, DEBOUNCE_MS),
    );
  }

  /** Mise à jour immédiate (attendue), sérialisée par réunion. Inclut les mises à jour en attente. */
  refreshNow(meetingId: string, parts: readonly CardPart[] = ALL): Promise<void> {
    clearTimeout(this.timers.get(meetingId));
    this.timers.delete(meetingId);
    const all = new Set<CardPart>([...parts, ...(this.pending.get(meetingId) ?? [])]);
    this.pending.delete(meetingId);
    const previous = this.queues.get(meetingId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.doRefresh(meetingId, all));
    this.queues.set(meetingId, next);
    void next
      .finally(() => {
        if (this.queues.get(meetingId) === next) this.queues.delete(meetingId);
      })
      .catch(() => undefined);
    return next;
  }

  private async doRefresh(meetingId: string, parts: Set<CardPart>): Promise<void> {
    if (parts.size === 0) return;
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting?.threadId) return;
    const thread = await fetchThread(this.client, meeting.threadId);
    if (!thread) return;
    await ensureUnarchived(thread);

    if (!meeting.agendaMessageId) parts.add('agenda'); // l'ODJ ne doit jamais disparaître de la carte sans son message
    if (parts.has('agenda')) {
      const created = await this.updateAgenda(meeting, thread);
      // Post antérieur à la séparation : la carte contient encore l'ODJ, on la régénère aussi.
      if (created) parts.add('card');
    }
    if (parts.has('card')) {
      // Dans un forum, le premier message porte le même id que le post.
      await this.edit(thread, thread.id, await this.renderCard(meeting), meetingId);
    }
  }

  /** Édite le message d'ODJ ; le (re)crée s'il n'existe pas. Renvoie vrai s'il a été créé. */
  private async updateAgenda(meeting: MeetingRow, thread: ThreadChannel): Promise<boolean> {
    const payload = await this.renderAgenda(meeting);
    if (meeting.agendaMessageId && (await this.edit(thread, meeting.agendaMessageId, payload, meeting.id))) return false;
    const message = await thread.send({ ...payload, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications });
    await this.repos.updateMeeting(meeting.id, { agendaMessageId: message.id });
    return true;
  }

  /** Renvoie faux si le message n'existe plus. */
  private async edit(thread: ThreadChannel, messageId: string, payload: RenderedMessage, meetingId: string): Promise<boolean> {
    try {
      const message = await thread.messages.fetch(messageId);
      await message.edit({ ...payload, allowedMentions: { parse: [] } });
      return true;
    } catch (err) {
      if (isUnknownMessage(err)) {
        this.log.warn({ meetingId, messageId }, 'Message de réunion supprimé');
        return false;
      }
      throw new Error(`Édition du message de réunion impossible : ${errorMessage(err)}`, { cause: err });
    }
  }

  /** Exécute immédiatement les mises à jour en attente (arrêt du bot). */
  async flush(): Promise<void> {
    const pending = [...this.pending.keys()];
    await Promise.allSettled([...pending.map((id) => this.refreshNow(id, [])), ...this.queues.values()]);
  }
}
