import { schedule, type ScheduledTask } from 'node-cron';
import { ChannelFlags, type Client, type ForumChannel, type Message, type ThreadChannel } from 'discord.js';
import type { Repositories } from '../db/repositories.js';
import { renderHub } from '../discord/embeds/hub.js';
import { ensureUnarchived } from '../discord/forum.js';
import { fetchForum, fetchThread, isUnknownMessage } from '../discord/threads.js';
import type { Messages } from '../i18n/index.js';
import { messages } from '../i18n/index.js';
import type { Logger } from '../lib/logger.js';
import type { SettingsService } from './settings.js';

const DEBOUNCE_MS = 2000;
const MAX_LISTED = 20;
/** Derniers comptes rendus listés dans le post épinglé. */
const RECENT_REPORTS = 5;

/**
 * Post épinglé du forum (« hub ») : bouton « Nouvelle réunion » et liste des réunions à venir,
 * régénérée à chaque création ou changement de statut. Le bot le surveille et le recrée
 * s'il disparaît (suppression, message effacé) ou le rétablit s'il est désépinglé, verrouillé ou archivé.
 */
export class HubService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Ids des posts épinglés, pour filtrer les messages sans requête BDD. */
  private readonly hubThreadIds = new Set<string>();
  private readonly ensuring = new Map<string, Promise<string>>();
  private watchdog: ScheduledTask | null = null;

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
   * Personne n'écrit dans le post épinglé : tout message d'un autre auteur que le bot est
   * supprimé (le post n'est pas verrouillé, sinon les membres ne pourraient plus cliquer).
   */
  async onMessage(message: Message): Promise<void> {
    if (!this.hubThreadIds.has(message.channelId) || message.author.id === this.client.user?.id) return;
    if (message.id === message.channelId) return; // premier message du post (le nôtre)
    await message.delete().catch((err) => this.log.warn({ threadId: message.channelId, err }, 'Suppression impossible dans le post épinglé'));
  }

  /**
   * Garantit que le forum du serveur a son post épinglé, complet (message présent, épinglé,
   * ni verrouillé ni archivé) ; le (re)crée sinon. Sérialisé par serveur : une suppression et la
   * vérification périodique ne peuvent pas créer deux posts. Renvoie l'id du post.
   */
  ensure(forum: ForumChannel, m: Messages): Promise<string> {
    const running = this.ensuring.get(forum.guildId);
    if (running) return running;
    const task = this.doEnsure(forum, m).finally(() => this.ensuring.delete(forum.guildId));
    this.ensuring.set(forum.guildId, task);
    return task;
  }

  /** Comme `ensure`, à partir des réglages du serveur ; ne fait rien si aucun forum n'est configuré. */
  async ensureForGuild(guildId: string): Promise<void> {
    const settings = await this.settings.get(guildId);
    const forum = await fetchForum(this.client, settings.forumChannelId);
    if (!forum) {
      if (settings.forumChannelId) this.log.warn({ guildId, forumId: settings.forumChannelId }, 'Forum des réunions introuvable');
      return;
    }
    await this.ensure(forum, messages(settings.locale));
  }

  /** Vérifie tous les serveurs configurés (démarrage + toutes les 15 min). */
  async ensureAll(): Promise<void> {
    for (const guildId of await this.repos.listConfiguredGuildIds()) {
      if (!this.client.guilds.cache.has(guildId)) continue;
      await this.ensureForGuild(guildId).catch((err) => this.log.warn({ guildId, err }, 'Vérification du post épinglé impossible'));
    }
  }

  startWatchdog(): void {
    this.watchdog = schedule('*/15 * * * *', () => this.ensureAll(), { name: 'hub-watchdog', noOverlap: true });
    // Au démarrage, le contenu est aussi régénéré : une nouvelle version peut changer ses boutons.
    void this.ensureAll().then(async () => {
      for (const guildId of await this.repos.listConfiguredGuildIds()) this.refresh(guildId);
    });
  }

  async stopWatchdog(): Promise<void> {
    await this.watchdog?.stop();
  }

  /** Post épinglé supprimé : on le recrée aussitôt. */
  async onThreadDelete(threadId: string, guildId: string): Promise<void> {
    if (!this.hubThreadIds.delete(threadId)) return;
    this.log.info({ guildId, threadId }, 'Post épinglé supprimé : recréation');
    await this.ensureForGuild(guildId);
  }

  /** Post épinglé désépinglé, verrouillé ou archivé : on rétablit. */
  async onThreadUpdate(thread: ThreadChannel): Promise<void> {
    if (!this.hubThreadIds.has(thread.id)) return;
    await this.keepAccessible(thread);
  }

  private async doEnsure(forum: ForumChannel, m: Messages): Promise<string> {
    const settings = await this.settings.get(forum.guildId);
    const existing = await fetchThread(this.client, settings.hubThreadId);
    if (existing && existing.parentId === forum.id) {
      const message = await existing.messages.fetch(existing.id).catch((err) => {
        if (isUnknownMessage(err)) return null;
        throw err;
      });
      if (message) {
        this.hubThreadIds.add(existing.id);
        await this.keepAccessible(existing);
        return existing.id;
      }
      // Message du post supprimé : le post est inutilisable, on le remplace.
      this.log.info({ guildId: forum.guildId, threadId: existing.id }, 'Message du post épinglé supprimé : remplacement');
      this.hubThreadIds.delete(existing.id);
      await existing.delete('Post épinglé incomplet, remplacé').catch(() => undefined);
    }

    const payload = renderHub(await this.upcoming(forum.guildId), m, await this.repos.listRecentReports(forum.guildId, RECENT_REPORTS));
    const thread = await forum.threads.create({
      name: m.hub.threadName,
      message: { ...payload, allowedMentions: { parse: [] } },
      reason: 'Post de création des réunions',
    });
    if (settings.hubThreadId) this.hubThreadIds.delete(settings.hubThreadId);
    this.hubThreadIds.add(thread.id);
    await this.repos.updateSettings(forum.guildId, { hubThreadId: thread.id });
    await this.keepAccessible(thread);
    this.log.info({ guildId: forum.guildId, threadId: thread.id }, 'Post épinglé créé');
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
    if (!settings.forumChannelId) return;
    const thread = await fetchThread(this.client, settings.hubThreadId);
    const message = thread ? await thread.messages.fetch(thread.id).catch(() => null) : null;
    if (!thread || !message) {
      await this.ensureForGuild(guildId); // absent ou incomplet : recréé (avec la liste à jour)
      return;
    }
    await ensureUnarchived(thread);
    await message.edit({
      ...renderHub(await this.upcoming(guildId), messages(settings.locale), await this.repos.listRecentReports(guildId, RECENT_REPORTS)),
      allowedMentions: { parse: [] },
    });
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

  /**
   * Épinglé, actif et surtout NON verrouillé : dans un post verrouillé, les membres sans
   * « Gérer les fils » ne peuvent plus cliquer sur les boutons. Le post reste vide grâce
   * à `onMessage`, qui supprime tout message posté par quelqu'un d'autre que le bot.
   */
  private async keepAccessible(thread: ThreadChannel): Promise<void> {
    const pinned = thread.flags.has(ChannelFlags.Pinned);
    if (pinned && !thread.locked && !thread.archived) return;
    try {
      await ensureUnarchived(thread);
      if (thread.locked) await thread.setLocked(false, 'Post de création des réunions : boutons accessibles à tous');
      if (!pinned) await thread.pin('Post de création des réunions');
    } catch (err) {
      this.log.warn({ threadId: thread.id, err }, 'Rétablissement du post épinglé impossible');
    }
  }
}
