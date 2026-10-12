import type { Client } from 'discord.js';
import type { Logger } from '../lib/logger.js';
import { commands } from './commands/index.js';

/**
 * Enregistre les commandes au démarrage (opération idempotente : écrase la liste existante).
 * En développement, `commandGuildIds` permet un enregistrement instantané sur des serveurs de test.
 *
 * Les deux modes sont exclusifs : des commandes à la fois globales et propres à un serveur
 * apparaîtraient en double. Chaque mode efface donc ce que l'autre a pu laisser.
 */
export async function registerCommands(client: Client<true>, guildIds: readonly string[], log: Logger): Promise<void> {
  const body = [...commands.values()].map((c) => c.data);

  if (guildIds.length === 0) {
    await client.application.commands.set(body);
    for (const guild of client.guilds.cache.values()) {
      const existing = await guild.commands.fetch().catch(() => null);
      if (existing && existing.size > 0) {
        await guild.commands.set([]);
        log.info({ guildId: guild.id }, 'Commandes propres au serveur supprimées (doublons des commandes globales)');
      }
    }
    log.info({ count: body.length }, 'Commandes enregistrées (globales)');
    return;
  }

  for (const guildId of guildIds) {
    await client.application.commands.set(body, guildId);
  }
  const global = await client.application.commands.fetch();
  if (global.size > 0) {
    await client.application.commands.set([]);
    log.info('Commandes globales supprimées (doublons des commandes de test)');
  }
  log.info({ count: body.length, guildIds }, 'Commandes enregistrées (serveurs de test)');
}
