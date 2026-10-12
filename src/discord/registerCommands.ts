import type { Client } from 'discord.js';
import type { Logger } from '../lib/logger.js';
import { commands } from './commands/index.js';

/**
 * Enregistre les commandes au démarrage (opération idempotente : écrase la liste existante).
 * En développement, `commandGuildIds` permet un enregistrement instantané sur des serveurs de test.
 */
export async function registerCommands(client: Client<true>, guildIds: readonly string[], log: Logger): Promise<void> {
  const body = [...commands.values()].map((c) => c.data);
  if (guildIds.length === 0) {
    await client.application.commands.set(body);
    log.info({ count: body.length }, 'Commandes enregistrées (globales)');
    return;
  }
  for (const guildId of guildIds) {
    await client.application.commands.set(body, guildId);
  }
  log.info({ count: body.length, guildIds }, 'Commandes enregistrées (serveurs de test)');
}
