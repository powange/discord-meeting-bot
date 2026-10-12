import { Team, type Client } from 'discord.js';
import type { Logger } from '../lib/logger.js';

/**
 * Propriétaires du bot : ceux du YAML (`owners`) et le propriétaire de l'application Discord
 * (ou les membres de son équipe). Eux seuls configurent les serveurs IA, qui sont des URL que
 * le bot appelle sur le réseau de l'hébergeur.
 */
export class OwnersService {
  private readonly ids: Set<string>;

  constructor(configured: readonly string[]) {
    this.ids = new Set(configured);
  }

  /** À appeler une fois connecté : ajoute le propriétaire de l'application. */
  async load(client: Client<true>, log: Logger): Promise<void> {
    try {
      const app = await client.application.fetch();
      const owner = app.owner;
      if (owner instanceof Team) for (const id of owner.members.keys()) this.ids.add(id);
      else if (owner) this.ids.add(owner.id);
    } catch (err) {
      log.warn({ err }, 'Propriétaire de l’application introuvable : seuls les « owners » du YAML sont reconnus');
    }
    log.info({ owners: [...this.ids] }, 'Propriétaires du bot');
  }

  isOwner(userId: string): boolean {
    return this.ids.has(userId);
  }
}
