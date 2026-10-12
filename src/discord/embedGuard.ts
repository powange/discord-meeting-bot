import { MessageFlags, type Client, type Message, type PartialMessage } from 'discord.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

/**
 * « Supprimer les intégrations » masque l'embed d'un message pour tout le monde (cartes de
 * réunion, ordre du jour, post épinglé…). Le bot rétablit aussitôt les intégrations de ses
 * propres messages (permission « Gérer les messages »).
 */
export async function restoreSuppressedEmbeds(client: Client, message: Message | PartialMessage, log: Logger): Promise<void> {
  if (!message.guildId) return;
  let full = message;
  if (full.partial || !full.author) {
    const fetched = await message.fetch().catch(() => null);
    if (!fetched) return;
    full = fetched;
  }
  if (full.author?.id !== client.user?.id) return;
  if (!full.flags.has(MessageFlags.SuppressEmbeds)) return;
  try {
    await full.suppressEmbeds(false);
    log.info({ channelId: full.channelId, messageId: full.id }, 'Intégrations supprimées d’un message du bot : rétablies');
  } catch (err) {
    log.warn({ messageId: full.id, err: errorMessage(err) }, 'Rétablissement des intégrations impossible');
  }
}
