import type { Client } from 'discord.js';
import type { Repositories } from '../db/repositories.js';
import { Throttle } from '../domain/throttle.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

/**
 * Alertes opérateur : postées dans le salon d'alertes du serveur (`/config` → Alertes), une
 * fois par heure au plus pour une même cause. Toujours journalisées.
 */
export class AlertService {
  private readonly throttle = new Throttle();

  constructor(
    private readonly client: Client,
    private readonly repos: Repositories,
    private readonly log: Logger,
  ) {}

  /** Alerte pour un serveur Discord donné. */
  async guild(guildId: string, cause: string, message: string): Promise<void> {
    this.log.warn({ guildId, cause }, message);
    if (!this.throttle.allow(`${guildId}:${cause}`)) return;
    const settings = await this.repos.getSettingsIfExists(guildId);
    if (!settings?.alertChannelId) return;
    await this.post(settings.alertChannelId, message);
  }

  /** Alerte qui concerne toute l'installation (disque…) : envoyée à tous les salons d'alertes. */
  async global(cause: string, message: string): Promise<void> {
    this.log.warn({ cause }, message);
    if (!this.throttle.allow(`*:${cause}`)) return;
    for (const channelId of await this.repos.listAlertChannels()) await this.post(channelId, message);
  }

  private async post(channelId: string, message: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isSendable()) await channel.send({ content: `🚨 ${message}`.slice(0, 2000), allowedMentions: { parse: [] } });
    } catch (err) {
      this.log.warn({ channelId, err: errorMessage(err) }, 'Alerte impossible à poster');
    }
  }
}
