import { ChannelType, type Client, type ForumChannel, type ThreadChannel } from 'discord.js';
import { discordErrorCode } from '../lib/errors.js';

const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

/** Post de forum d'une réunion, ou `null` s'il a été supprimé. */
export async function fetchThread(client: Client, threadId: string | null): Promise<ThreadChannel | null> {
  if (!threadId) return null;
  try {
    const channel = await client.channels.fetch(threadId);
    return channel?.isThread() ? channel : null;
  } catch (err) {
    if (discordErrorCode(err) === UNKNOWN_CHANNEL) return null;
    throw err;
  }
}

export async function fetchForum(client: Client, channelId: string | null): Promise<ForumChannel | null> {
  if (!channelId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    return channel?.type === ChannelType.GuildForum ? channel : null;
  } catch (err) {
    if (discordErrorCode(err) === UNKNOWN_CHANNEL) return null;
    throw err;
  }
}

export function isUnknownMessage(err: unknown): boolean {
  return discordErrorCode(err) === UNKNOWN_MESSAGE;
}
