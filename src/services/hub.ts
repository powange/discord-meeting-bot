import { ChannelFlags, type Client, type ForumChannel, type Message, type ThreadChannel } from 'discord.js';
import type { Repositories } from '../db/repositories.js';
import { renderHub } from '../discord/embeds/hub.js';
import { ensureUnarchived } from '../discord/forum.js';
import { fetchThread } from '../discord/threads.js';
import type { Messages } from '../i18n/index.js';
import { messages } from '../i18n/index.js';
import type { Logger } from '../lib/logger.js';
import type { SettingsService } from './settings.js';

const DEBOUNCE_MS = 2000;
const MAX_LISTED = 20;

/**
 * Post épinglé du forum (« hub ») : bouton « Nouvelle réunion » et liste des réunions à venir,
 * régénérée à chaque création ou changement de statut.
 */
export class HubService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Ids des posts épinglés, pour filtrer les messages sans requête BDD. */
  private readonly hubThreadIds = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly repos: Repositories,
    private readonly settings: SettingsService,
    private readonly log: Logger,
  ) {}

  async load(): Promise<void> {
    for (const id of await this.repos.listHubThreadIds()) this.hubThreadIds.add(id);
  }

  /**
   * Personne n'écrit dans le post épinglé : le verrou bloque les membres, et ce filtre
   * supprime les messages des modérateurs (qui passent outre le verrou).
   */
  async onMessage(message: Message): Promise<void> {
    if (!this.hubThreadIds.has(message.channelId) || message.author.id === this.client.user?.id) return;
    if (message.id === message.channelId) return; // premier message du post (le nôtre)
    await message.delete().catch((err) => this.log.warn({ threadId: message.channelId, err }, 'Suppression impossible dans le post épinglé'));
  }

  /** Crée le post épinglé dans `forum` (ou réutilise celui existant s'il y est encore). Renvoie son id. */
  async ensure(forum: ForumChannel, m: Messages): Promise<string> {
    const settings = await this.settings.get(forum.guildId);
    const existing = await fetchThread(this.client, settings.hubThreadId);
    if (existing && existing.parentId === forum.id) {
      await this.pinAndLock(existing);
      await this.refreshNow(forum.guildId);
      return existing.id;
    }

    const payload = renderHub(await this.upcoming(forum.guildId), m);
    const thread = await forum.threads.create({
      name: m.hub.threadName,
      message: { ...payload, allowedMentions: { parse: [] } },
      reason: 'Post de création des réunions',
    });
    await this.pinAndLock(thread);
    await this.repos.updateSettings(forum.guildId, { hubThreadId: thread.id });
    if (settings.hubThreadId) this.hubThreadIds.delete(settings.hubThreadId);
    this.hubThreadIds.add(thread.id);
    return thread.id;
  }

  refresh(guildId: string): void {
    clearTimeout(this.timers.get(guildId));
    this.timers.set(
      guildId,
      setTimeout(() => {
        this.timers.delete(guildId);
        this.refreshNow(guildId).catch((err) => this.log.warn({ guildId, err }, 'Mise à jour du post épinglé impossible'));
      }, DEBOUNCE_MS),
    );
  }

  async refreshNow(guildId: string): Promise<void> {
    const settings = await this.settings.get(guildId);
    const thread = await fetchThread(this.client, settings.hubThreadId);
    if (!thread) return;
    const payload = renderHub(await this.upcoming(guildId), messages(settings.locale));
    await ensureUnarchived(thread);
    const message = await thread.messages.fetch(thread.id);
    await message.edit({ ...payload, allowedMentions: { parse: [] } });
  }

  async flush(): Promise<void> {
    const pending = [...this.timers.keys()];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await Promise.allSettled(pending.map((id) => this.refreshNow(id)));
  }

  private async upcoming(guildId: string) {
    const rows = await this.repos.listMeetings(guildId, ['scheduled', 'live']);
    return rows
      .filter((r): r is typeof r & { threadId: string } => r.threadId !== null)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .slice(0, MAX_LISTED);
  }

  /** Épinglé en tête du forum, et verrouillé : seuls les modérateurs peuvent y répondre. */
  private async pinAndLock(thread: ThreadChannel): Promise<void> {
    try {
      await ensureUnarchived(thread);
      if (!thread.flags.has(ChannelFlags.Pinned)) await thread.pin('Post de création des réunions');
      if (!thread.locked) await thread.setLocked(true, 'Post de création des réunions');
    } catch (err) {
      this.log.warn({ threadId: thread.id, err }, 'Épinglage du post impossible');
    }
  }
}
