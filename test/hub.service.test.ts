import { ChannelFlags, ChannelType } from 'discord.js';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../src/i18n/index.js';
import { HubService } from '../src/services/hub.js';

const m = messages('fr');
const log = pino({ level: 'silent' });
const unknownMessage = () => Object.assign(new Error('Unknown Message'), { code: 10008 });

/** Post de forum simulé : état d'épinglage et de verrouillage, message de tête présent ou non. */
function hubThread(id: string, opts: { pinned?: boolean; locked?: boolean; archived?: boolean; messageGone?: boolean } = {}) {
  const head = { id, edit: vi.fn(async () => undefined) };
  const thread = {
    id,
    parentId: 'forum',
    locked: opts.locked ?? false,
    archived: opts.archived ?? false,
    flags: { has: (flag: number) => flag === ChannelFlags.Pinned && (opts.pinned ?? true) },
    isThread: () => true,
    messages: { fetch: vi.fn(async () => (opts.messageGone ? Promise.reject(unknownMessage()) : head)) },
    setLocked: vi.fn(async () => undefined),
    setArchived: vi.fn(async () => undefined),
    pin: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  return { thread, head };
}

function setup(opts: { hubThreadId?: string | null; existing?: ReturnType<typeof hubThread> } = {}) {
  let settings = { guildId: 'g', locale: 'fr', forumChannelId: 'forum', hubThreadId: opts.hubThreadId ?? null };
  const created: Array<ReturnType<typeof hubThread>> = [];
  const forum = {
    id: 'forum',
    guildId: 'g',
    type: ChannelType.GuildForum,
    threads: {
      create: vi.fn(async () => {
        const t = hubThread(`hub${created.length + 1}`, { pinned: false });
        created.push(t);
        return t.thread;
      }),
    },
  };
  const channels = new Map<string, unknown>([['forum', forum]]);
  if (opts.existing) channels.set(opts.existing.thread.id, opts.existing.thread);
  const client = {
    user: { id: 'bot' },
    channels: {
      fetch: async (id: string) => {
        const found = channels.get(id) ?? created.find((t) => t.thread.id === id)?.thread;
        if (!found) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
        return found;
      },
    },
    guilds: { cache: new Map([['g', {}]]) },
  };
  const repos = {
    listHubThreadIds: async () => (settings.hubThreadId ? [settings.hubThreadId] : []),
    listConfiguredGuildIds: async () => ['g'],
    listMeetings: async () => [],
    listRecentReports: async () => [],
    updateSettings: vi.fn(async (_g: string, patch: Partial<typeof settings>) => {
      settings = { ...settings, ...patch };
    }),
  };
  const hub = new HubService(client as never, repos as never, { get: async () => settings } as never, log);
  return { hub, forum, created, repos, settings: () => settings, removeChannel: (id: string) => channels.delete(id) };
}

afterEach(() => vi.useRealTimers());

describe('post épinglé : personne n’y écrit', () => {
  it('message d’un membre supprimé ; ceux du bot et le message de tête conservés ; autres posts ignorés', async () => {
    const { hub } = setup({ hubThreadId: 'hub' });
    await hub.load();
    const msg = (author: string, id = 'm1', channelId = 'hub') => ({ id, channelId, author: { id: author }, delete: vi.fn(async () => undefined) });
    const member = msg('member');
    const bot = msg('bot');
    const head = msg('member', 'hub');
    const elsewhere = msg('member', 'm2', 'other');
    for (const message of [member, bot, head, elsewhere]) await hub.onMessage(message as never);
    expect(member.delete).toHaveBeenCalled();
    expect(bot.delete).not.toHaveBeenCalled();
    expect(head.delete).not.toHaveBeenCalled();
    expect(elsewhere.delete).not.toHaveBeenCalled();
  });
});

describe('post épinglé : toujours présent et accessible', () => {
  it('appels simultanés : un seul post créé, épinglé, enregistré', async () => {
    const { hub, forum, created, settings } = setup();
    const [a, b] = await Promise.all([hub.ensure(forum as never, m), hub.ensure(forum as never, m)]);
    expect(forum.threads.create).toHaveBeenCalledOnce();
    expect(a).toBe(b);
    expect(settings().hubThreadId).toBe('hub1');
    expect(created[0]!.thread.pin).toHaveBeenCalled();
  });

  it('message de tête supprimé à la main : le post est remplacé', async () => {
    const existing = hubThread('old', { messageGone: true });
    const { hub, forum, settings } = setup({ hubThreadId: 'old', existing });
    expect(await hub.ensure(forum as never, m)).toBe('hub1');
    expect(existing.thread.delete).toHaveBeenCalled();
    expect(settings().hubThreadId).toBe('hub1');
  });

  it('post désépinglé et verrouillé : déverrouillé (sinon les boutons sont inaccessibles) et réépinglé, jamais recréé', async () => {
    const existing = hubThread('hub', { pinned: false, locked: true });
    const { hub, forum } = setup({ hubThreadId: 'hub', existing });
    expect(await hub.ensure(forum as never, m)).toBe('hub');
    expect(existing.thread.setLocked).toHaveBeenCalledWith(false, expect.any(String));
    expect(existing.thread.pin).toHaveBeenCalled();
    expect(forum.threads.create).not.toHaveBeenCalled();
  });

  it('post en ordre : rien n’est modifié', async () => {
    const existing = hubThread('hub');
    const { hub, forum } = setup({ hubThreadId: 'hub', existing });
    await hub.ensure(forum as never, m);
    expect(existing.thread.setLocked).not.toHaveBeenCalled();
    expect(existing.thread.pin).not.toHaveBeenCalled();
  });

  it('post supprimé : recréé aussitôt ; la suppression d’un autre post est ignorée', async () => {
    const existing = hubThread('hub');
    const { hub, forum, removeChannel } = setup({ hubThreadId: 'hub', existing });
    await hub.load();
    await hub.onThreadDelete('autre', 'g');
    expect(forum.threads.create).not.toHaveBeenCalled();
    removeChannel('hub'); // Discord ne le renvoie plus
    await hub.onThreadDelete('hub', 'g');
    expect(forum.threads.create).toHaveBeenCalledOnce();
  });

  it('mises à jour rapprochées : une seule édition du post', async () => {
    vi.useFakeTimers();
    const existing = hubThread('hub');
    const { hub } = setup({ hubThreadId: 'hub', existing });
    hub.refresh('g');
    hub.refresh('g');
    hub.refresh('g');
    await vi.advanceTimersByTimeAsync(2500);
    expect(existing.head.edit).toHaveBeenCalledOnce();
  });
});
