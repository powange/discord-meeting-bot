import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { postsReserved, setPostsReserved } from '../src/discord/forum.js';

/** Forum simulé : permissions du bot (serveur et forum) et autorisations/refus posés sur le forum. */
function forum(opts: { manageRoles: boolean; everyoneDeny?: bigint }) {
  const botPerms = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.ManageChannels,
    ...(opts.manageRoles ? [PermissionFlagsBits.ManageRoles] : []),
  ]);
  const edits: Array<[string, Record<string, boolean | null>, { type: number }]> = [];
  const me = { id: 'bot', permissions: botPerms };
  return {
    edits,
    channel: {
      guild: { id: 'guild', members: { me } },
      permissionsFor: () => botPerms,
      permissionOverwrites: {
        cache: new Map(opts.everyoneDeny !== undefined ? [['guild', { deny: new PermissionsBitField(opts.everyoneDeny) }]] : []),
        edit: vi.fn(async (id: string, perms: Record<string, boolean | null>, o: { type: number }) => void edits.push([id, perms, o])),
      },
    },
  };
}

describe('création de posts réservée au bot', () => {
  it('état lu sur le refus « Envoyer des messages » de @everyone', () => {
    expect(postsReserved(forum({ manageRoles: true }).channel as never)).toBe(false);
    expect(postsReserved(forum({ manageRoles: true, everyoneDeny: PermissionFlagsBits.SendMessages }).channel as never)).toBe(true);
  });

  it('réserver : le bot s’autorise d’abord (avec ses seules permissions, sans « Gérer les salons »), puis @everyone perd « Envoyer des messages » seulement', async () => {
    const f = forum({ manageRoles: true });
    expect(await setPostsReserved(f.channel as never, true, 'test')).toBe(true);
    expect(f.edits.map(([id]) => id)).toEqual(['bot', 'guild']);
    expect(f.edits[0]![1]).toEqual({ ViewChannel: true, SendMessages: true, SendMessagesInThreads: true, ManageThreads: true });
    expect(f.edits[0]![2]).toMatchObject({ type: 1 });
    expect(f.edits[1]).toEqual(['guild', { SendMessages: false }, { reason: 'test', type: 0 }]);
  });

  it('rouvrir : le refus de @everyone est retiré (hérité de nouveau)', async () => {
    const f = forum({ manageRoles: true, everyoneDeny: PermissionFlagsBits.SendMessages });
    await setPostsReserved(f.channel as never, false, 'test');
    expect(f.edits).toEqual([['guild', { SendMessages: null }, { reason: 'test', type: 0 }]]);
  });

  it('sans « Gérer les permissions » : rien n’est modifié, faux', async () => {
    const f = forum({ manageRoles: false });
    expect(await setPostsReserved(f.channel as never, true, 'test')).toBe(false);
    expect(f.edits).toEqual([]);
  });
});
