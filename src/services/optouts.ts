import type { Client } from 'discord.js';
import type { Repositories } from '../db/repositories.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

/**
 * Refus d'enregistrement, gardés en base par le bot (aucun rôle : le choix reste discret).
 * Cache mémoire par serveur : la décision « enregistrer ou non » est prise à chaque paquet audio.
 */
export class OptoutService {
  private readonly cache = new Map<string, Set<string>>();

  constructor(
    private readonly repos: Repositories,
    private readonly log: Logger,
  ) {}

  /** Charge (ou recharge) la liste d'un serveur ; à appeler avant un enregistrement. */
  async load(guildId: string): Promise<Set<string>> {
    const set = new Set(await this.repos.listOptouts(guildId));
    this.cache.set(guildId, set);
    return set;
  }

  /** Lecture synchrone (cache) ; un serveur non chargé est considéré sans refus. */
  isOptedOut(guildId: string, userId: string): boolean {
    return this.cache.get(guildId)?.has(userId) ?? false;
  }

  async list(guildId: string): Promise<string[]> {
    return [...(this.cache.get(guildId) ?? (await this.load(guildId)))];
  }

  async set(guildId: string, userId: string, refused: boolean): Promise<void> {
    await this.repos.setOptout(guildId, userId, refused);
    const set = this.cache.get(guildId) ?? (await this.load(guildId));
    if (refused) set.add(userId);
    else set.delete(userId);
  }

  /**
   * Reprise de l'ancien rôle « ne pas m'enregistrer » : ses membres deviennent des refus en
   * base, puis le rôle est oublié (il n'est pas supprimé du serveur).
   */
  async migrateRoles(client: Client<true>, guilds: ReadonlyArray<{ guildId: string; optoutRoleId: string }>, clearRole: (guildId: string) => Promise<void>): Promise<void> {
    for (const { guildId, optoutRoleId } of guilds) {
      try {
        const guild = await client.guilds.fetch(guildId);
        await guild.members.fetch();
        const members = guild.roles.cache.get(optoutRoleId)?.members ?? new Map();
        for (const id of members.keys()) await this.repos.setOptout(guildId, id, true);
        await clearRole(guildId);
        this.log.info({ guildId, migrated: members.size }, 'Rôle « ne pas m’enregistrer » repris en base');
      } catch (err) {
        this.log.warn({ guildId, err: errorMessage(err) }, 'Reprise du rôle « ne pas m’enregistrer » impossible');
      }
    }
  }
}
