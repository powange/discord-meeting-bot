import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import type { MeetingRow } from '../src/db/schema.js';
import { MeetingService } from '../src/services/meetings.js';

const unknownChannel = () => Object.assign(new Error('Unknown Channel'), { code: 10003 });

function setup(status: string, fetchThread: () => Promise<unknown> = async () => Promise.reject(unknownChannel())) {
  let meeting = { id: 'm1', guildId: 'g', threadId: 't1', status, title: 'Bureau', scheduledEventId: null } as unknown as MeetingRow;
  const updates: Array<Partial<MeetingRow>> = [];
  const repos = {
    getMeetingByThread: async (id: string) => (meeting.threadId === id ? meeting : undefined),
    updateMeeting: async (_id: string, patch: Partial<MeetingRow>) => {
      updates.push(patch);
      meeting = { ...meeting, ...patch };
      return meeting;
    },
    // Annulation : seulement depuis un statut ouvert.
    transitionMeeting: async (_id: string, from: string[], to: string) => (from.includes(meeting.status) ? (meeting = { ...meeting, status: to } as MeetingRow) : undefined),
    cancelPendingJobs: async () => undefined,
    listMeetingsWithThread: async () => (meeting.threadId ? [meeting] : []),
  };
  const onChange = vi.fn();
  const service = new MeetingService(
    buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
    { channels: { fetch: fetchThread }, guilds: { fetch: async () => null } } as never,
    repos as never,
    { get: async () => ({ guildId: 'g', locale: 'fr' }), messages: async () => ({}) } as never,
    {} as never,
    pino({ level: 'silent' }),
    onChange,
  );
  const beforeClose = vi.fn(async () => undefined);
  service.hooks = { afterStart: async () => undefined, beforeClose, afterEnd: async () => undefined } as never;
  return { service, updates, onChange, beforeClose, meeting: () => meeting };
}

describe('post de réunion supprimé à la main', () => {
  it('réunion terminée : post oublié (plus dans les derniers comptes rendus), post épinglé mis à jour', async () => {
    const s = setup('ended');
    await s.service.onThreadDeleted('t1');
    expect(s.meeting().threadId).toBeNull();
    expect(s.meeting().status).toBe('ended');
    expect(s.onChange).toHaveBeenCalledWith('g');
  });

  it('réunion ouverte : post oublié avant l’annulation (l’arrêt de l’enregistrement ne lance pas de compte rendu)', async () => {
    const s = setup('live');
    s.beforeClose.mockImplementation(async () => {
      expect(s.meeting().threadId).toBeNull();
    });
    await s.service.onThreadDeleted('t1');
    expect(s.meeting().status).toBe('cancelled');
    expect(s.beforeClose).toHaveBeenCalledOnce();
  });

  it('au démarrage : post disparu pendant l’arrêt → traité ; erreur passagère → rien conclu', async () => {
    const gone = setup('scheduled');
    expect(await gone.service.checkDeletedThreads()).toBe(1);
    expect(gone.meeting().status).toBe('cancelled');
    const flaky = setup('scheduled', async () => Promise.reject(Object.assign(new Error('réseau'), { code: 'ECONNRESET' })));
    expect(await flaky.service.checkDeletedThreads()).toBe(0);
    expect(flaky.meeting().threadId).toBe('t1');
    const present = setup('scheduled', async () => ({ isThread: () => true }));
    expect(await present.service.checkDeletedThreads()).toBe(0);
  });
});
