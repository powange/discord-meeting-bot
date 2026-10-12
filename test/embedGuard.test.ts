import { MessageFlags, MessageFlagsBitField, type Client, type Message } from 'discord.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { restoreSuppressedEmbeds } from '../src/discord/embedGuard.js';

const client = { user: { id: 'bot' } } as unknown as Client;
const log = pino({ level: 'silent' });

function message(over: { author?: string | null; suppressed?: boolean; partial?: boolean }) {
  const calls: boolean[] = [];
  const full = {
    guildId: 'g',
    channelId: 'c',
    id: 'm',
    partial: false,
    author: { id: over.author ?? 'bot' },
    flags: new MessageFlagsBitField(over.suppressed ? MessageFlags.SuppressEmbeds : 0),
    suppressEmbeds: async (v: boolean) => void calls.push(v),
  };
  const msg = over.partial ? { ...full, partial: true, author: null, fetch: async () => full } : full;
  return { msg: msg as unknown as Message, calls };
}

describe('rétablissement des intégrations supprimées', () => {
  it('message du bot dont l’embed a été supprimé : rétabli', async () => {
    const { msg, calls } = message({ suppressed: true });
    await restoreSuppressedEmbeds(client, msg, log);
    expect(calls).toEqual([false]);
  });
  it('message partiel (publié avant un redémarrage) : récupéré puis rétabli', async () => {
    const { msg, calls } = message({ suppressed: true, partial: true });
    await restoreSuppressedEmbeds(client, msg, log);
    expect(calls).toEqual([false]);
  });
  it('message d’un autre auteur, ou intégrations présentes : rien', async () => {
    for (const over of [{ author: 'someone', suppressed: true }, { suppressed: false }]) {
      const { msg, calls } = message(over);
      await restoreSuppressedEmbeds(client, msg, log);
      expect(calls).toEqual([]);
    }
  });
});
