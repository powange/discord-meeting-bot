import type { Client } from 'discord.js';
import type { Repositories } from '../db/repositories.js';
import type { MeetingRow } from '../db/schema.js';
import { ensureUnarchived } from '../discord/forum.js';
import { renderMeetingCard, type RenderedMessage } from '../discord/embeds/meetingCard.js';
import { fetchThread, isUnknownMessage } from '../discord/threads.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { SettingsService } from './settings.js';

const DEBOUNCE_MS = 1000;

/**
 * Met à jour la carte (premier message du post). Les demandes sont regroupées (debounce) pour
 * absorber les rafales de clics, et sérialisées par réunion pour qu'une édition lente ne
 * soit jamais écrasée par une plus ancienne.
 */
export class CardService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly client: Client,
    private readonly repos: Repositories,
    private readonly settings: SettingsService,
    private readonly log: Logger,
  ) {}

  async render(meeting: MeetingRow): Promise<RenderedMessage> {
    const [rsvps, agenda, m] = await Promise.all([
      this.repos.listRsvps(meeting.id),
      this.repos.listAgenda(meeting.id),
      this.settings.messages(meeting.guildId),
    ]);
    return renderMeetingCard(meeting, rsvps, agenda, m);
  }

  /** Mise à jour différée (regroupée). */
  refresh(meetingId: string): void {
    clearTimeout(this.timers.get(meetingId));
    this.timers.set(
      meetingId,
      setTimeout(() => {
        this.timers.delete(meetingId);
        this.refreshNow(meetingId).catch((err) => this.log.error({ meetingId, err }, 'Mise à jour de la carte échouée'));
      }, DEBOUNCE_MS),
    );
  }

  /** Mise à jour immédiate (attendue), sérialisée par réunion. */
  refreshNow(meetingId: string): Promise<void> {
    clearTimeout(this.timers.get(meetingId));
    this.timers.delete(meetingId);
    const previous = this.queues.get(meetingId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.doRefresh(meetingId));
    this.queues.set(meetingId, next);
    void next.finally(() => {
      if (this.queues.get(meetingId) === next) this.queues.delete(meetingId);
    }).catch(() => undefined);
    return next;
  }

  private async doRefresh(meetingId: string): Promise<void> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting?.threadId) return;
    const thread = await fetchThread(this.client, meeting.threadId);
    if (!thread) return;
    const payload = await this.render(meeting);
    await ensureUnarchived(thread);
    try {
      // Dans un forum, le premier message porte le même id que le post.
      const message = await thread.messages.fetch(thread.id);
      await message.edit({ ...payload, allowedMentions: { parse: [] } });
    } catch (err) {
      if (isUnknownMessage(err)) {
        this.log.warn({ meetingId, threadId: thread.id }, 'Carte de réunion supprimée : impossible de la mettre à jour');
        return;
      }
      throw new Error(`Édition de la carte impossible : ${errorMessage(err)}`, { cause: err });
    }
  }

  /** Exécute immédiatement les mises à jour en attente (arrêt du bot). */
  async flush(): Promise<void> {
    const pending = [...this.timers.keys()];
    await Promise.allSettled([...pending.map((id) => this.refreshNow(id)), ...this.queues.values()]);
  }
}
