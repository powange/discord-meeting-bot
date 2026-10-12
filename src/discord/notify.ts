import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type APIActionRowComponent, type APIComponentInMessageActionRow, type Client } from 'discord.js';
import type { Messages } from '../i18n/index.js';

/** Nom du salon vocal en texte (les mentions `<#id>` s'affichent brutes dans les notifications mobiles). */
export async function voiceName(client: Client, channelId: string, m: Messages): Promise<string> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return channel && 'name' in channel && channel.name ? channel.name : m.thread.voiceFallback;
}

/** Nom d'affichage d'un membre, ou `null` s'il est introuvable. */
export async function displayName(client: Client, guildId: string, userId: string): Promise<string | null> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  const member = await guild?.members.fetch(userId).catch(() => null);
  return member?.displayName ?? null;
}

/** Bouton lien qui ouvre le salon vocal. */
export function joinVoiceRow(guildId: string, channelId: string, m: Messages): APIActionRowComponent<APIComponentInMessageActionRow> {
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(m.buttons.joinVoice).setEmoji('🔊').setURL(`https://discord.com/channels/${guildId}/${channelId}`),
    )
    .toJSON();
}
