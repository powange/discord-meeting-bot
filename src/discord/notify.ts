import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type Client,
  type ThreadChannel,
} from 'discord.js';
import { chunkJoin } from '../lib/text.js';
import type { Messages } from '../i18n/index.js';

/** Nom du salon vocal en texte (les mentions `<#id>` s'affichent brutes dans les notifications mobiles). */
export async function voiceName(client: Client, channelId: string | null, m: Messages): Promise<string> {
  if (!channelId) return m.thread.voicePending;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return channel && 'name' in channel && channel.name ? channel.name : m.thread.voiceFallback;
}

/** Nom d'affichage d'un membre, ou `null` s'il est introuvable. */
export async function displayName(client: Client, guildId: string, userId: string): Promise<string | null> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  const member = await guild?.members.fetch(userId).catch(() => null);
  return member?.displayName ?? null;
}

/** Bouton « Rejoindre le vocal », absent tant que le salon temporaire n'est pas créé. */
export function joinVoiceRows(guildId: string, channelId: string | null, m: Messages): APIActionRowComponent<APIComponentInMessageActionRow>[] {
  return channelId ? [joinVoiceRow(guildId, channelId, m)] : [];
}

/** Bouton lien qui ouvre le salon vocal. */
export function joinVoiceRow(guildId: string, channelId: string, m: Messages): APIActionRowComponent<APIComponentInMessageActionRow> {
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(m.buttons.joinVoice).setEmoji('🔊').setURL(`https://discord.com/channels/${guildId}/${channelId}`),
    )
    .toJSON();
}

const MESSAGE_MAX = 2000;

/** Découpe une liste de mentions en messages de 2000 caractères max, chacun autorisant ses propres mentions. */
export function mentionBatches(prefix: string, userIds: readonly string[]): Array<{ content: string; users: string[] }> {
  if (userIds.length === 0) return [{ content: prefix.trimEnd(), users: [] }];
  const allowed = new Set(userIds); // le titre ne doit pas pouvoir mentionner quelqu'un d'autre
  return chunkJoin(prefix, userIds.map((id) => `<@${id}>`), MESSAGE_MAX).map((content) => ({
    content,
    users: [...new Set([...content.matchAll(/<@(\d+)>/g)].map((match) => match[1]!))].filter((id) => allowed.has(id)),
  }));
}

/**
 * Envoie `text` dans le post en mentionnant `userIds` sur une ligne à part (`label`), pour que
 * les intéressés soient notifiés : le post est créé par le bot, personne n'en est membre d'office.
 * Les composants ne sont joints qu'au premier message.
 */
export async function sendWithMentions(
  thread: ThreadChannel,
  text: string,
  label: string,
  userIds: readonly string[],
  components: APIActionRowComponent<APIComponentInMessageActionRow>[] = [],
): Promise<void> {
  const batches = mentionBatches(userIds.length > 0 ? `${text}\n${label} ` : text, userIds);
  for (const [i, batch] of batches.entries()) {
    await thread.send({ content: batch.content, allowedMentions: { users: batch.users }, ...(i === 0 ? { components } : {}) });
  }
}
