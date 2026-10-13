import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeetingRow } from '../src/db/schema.js';
import { messages } from '../src/i18n/index.js';
import { CardService } from '../src/services/cards.js';
import { fakeThread } from './helpers/discordFakes.js';

const m = messages('fr');
const log = pino({ level: 'silent' });

/** Post simulé dont le premier message (la carte) porte l'id du post, et le second l'ordre du jour. */
function setup(opts: { agendaGone?: boolean } = {}) {
  const t = fakeThread('thread1');
  const card = { id: 'thread1', edit: vi.fn(async () => undefined) };
  const agenda = { id: 'agenda1', edit: vi.fn(async () => undefined) };
  t.thread.messages.fetch.mockImplementation(async (id: string) => {
    if (id === 'thread1') return card as never;
    if (id === 'agenda1' && !opts.agendaGone) return agenda as never;
    throw Object.assign(new Error('Unknown Message'), { code: 10008 });
  });
  let meeting = {
    id: 'm1', guildId: 'g', threadId: 'thread1', agendaMessageId: 'agenda1', title: 'Bureau', description: '', status: 'scheduled',
    startsAt: new Date('2026-10-20T16:00:00Z'), durationMin: 60, voiceChannelId: 'v', organizerId: 'o', autoRecord: false, agendaLocked: false,
  } as unknown as MeetingRow;
  const repos = {
    getMeeting: async () => meeting,
    listRsvps: async () => [],
    getActiveRecording: async () => undefined,
    publishedLinks: async () => ({ report: null, audio: null }),
    listAgenda: async () => [],
    updateMeeting: vi.fn(async (_id: string, patch: Partial<MeetingRow>) => {
      meeting = { ...meeting, ...patch };
      return meeting;
    }),
  };
  const client = { channels: { fetch: async () => t.thread } };
  const cards = new CardService(client as never, repos as never, { messages: async () => m, get: async () => ({ locale: 'fr' }) } as never, log);
  return { cards, card, agenda, thread: t, repos };
}

afterEach(() => vi.useRealTimers());

describe('mises à jour de la carte et de l’ordre du jour', () => {
  it('rafale de clics : une seule édition, parties demandées regroupées', async () => {
    vi.useFakeTimers();
    const { cards, card, agenda } = setup();
    cards.refresh('m1', ['card']);
    cards.refresh('m1', ['card']);
    cards.refresh('m1', ['agenda']);
    await vi.advanceTimersByTimeAsync(1500);
    expect(card.edit).toHaveBeenCalledOnce();
    expect(agenda.edit).toHaveBeenCalledOnce();
  });

  it('seule la partie concernée est éditée', async () => {
    const { cards, card, agenda } = setup();
    await cards.refreshNow('m1', ['agenda']);
    expect(agenda.edit).toHaveBeenCalledOnce();
    expect(card.edit).not.toHaveBeenCalled();
  });

  it('message d’ordre du jour supprimé : republié, enregistré, et la carte régénérée avec', async () => {
    const { cards, card, thread, repos } = setup({ agendaGone: true });
    await cards.refreshNow('m1', ['agenda']);
    expect(thread.sent).toHaveLength(1);
    expect(repos.updateMeeting).toHaveBeenCalledWith('m1', { agendaMessageId: 'msg1' });
    expect(card.edit).toHaveBeenCalledOnce();
  });

  it('éditions sérialisées : une édition lente n’est jamais doublée par la suivante', async () => {
    const { cards, card } = setup();
    const order: string[] = [];
    let release!: () => void;
    card.edit.mockImplementationOnce(async () => {
      order.push('début 1');
      await new Promise<void>((r) => (release = r));
      order.push('fin 1');
    });
    card.edit.mockImplementationOnce(async () => {
      order.push('2');
    });
    const first = cards.refreshNow('m1', ['card']);
    const second = cards.refreshNow('m1', ['card']);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['début 1', 'fin 1', '2']);
  });

  it('mises à jour en attente exécutées à l’arrêt du bot', async () => {
    vi.useFakeTimers();
    const { cards, card } = setup();
    cards.refresh('m1', ['card']);
    await cards.flush();
    expect(card.edit).toHaveBeenCalledOnce();
  });
});
