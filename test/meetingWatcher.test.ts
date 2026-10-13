import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import type { MeetingRow } from '../src/db/schema.js';
import { MeetingWatcher } from '../src/services/meetingWatcher.js';

const at = (hhmm: string) => new Date(`2026-10-15T${hhmm}:00Z`);
const config = buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}); // délai par défaut : 5 min
const live = { id: 'm1', guildId: 'g', status: 'live', voiceChannelId: 'v', startsAt: at('18:00'), durationMin: 60, startedAt: at('18:00') } as MeetingRow;

/** Vocal dont on change les occupants entre deux passages. */
function setup(meeting: MeetingRow = live, temporary: MeetingRow[] = []) {
  let people: Array<{ bot: boolean }> = [];
  const channel = {
    isVoiceBased: () => true,
    get members() {
      return { filter: (fn: (mb: { user: { bot: boolean } }) => boolean) => ({ size: people.map((p) => ({ user: p })).filter(fn).length }) };
    },
  };
  const end = vi.fn(async () => true);
  const deleteTemporaryVoice = vi.fn(async () => true);
  const ensureVoice = vi.fn(async () => undefined);
  const watcher = new MeetingWatcher(
    { channels: { cache: { get: () => channel } } } as never,
    { listOpenMeetings: async () => [meeting], listTemporaryVoicesToDelete: async () => temporary } as never,
    { end, deleteTemporaryVoice, ensureVoice } as never,
    config,
    pino({ level: 'silent' }),
  );
  // La surveillance ne compte qu'à partir de son propre démarrage après un redémarrage.
  (watcher as unknown as { startedAt: Date }).startedAt = at('17:00');
  return { watcher, end, deleteTemporaryVoice, ensureVoice, setPeople: (p: Array<{ bot: boolean }>) => (people = p) };
}

describe('surveillance des réunions en cours', () => {
  it('jamais close tant que quelqu’un est là, même bien après l’heure de fin', async () => {
    const { watcher, end, setPeople } = setup();
    setPeople([{ bot: false }]);
    await watcher.check(at('21:00'));
    expect(end).not.toHaveBeenCalled();
  });

  it('close 5 min après le départ du dernier participant (après l’heure de fin)', async () => {
    const { watcher, end, setPeople } = setup();
    setPeople([{ bot: false }]);
    await watcher.check(at('19:10'));
    setPeople([]);
    await watcher.check(at('19:14'));
    expect(end).not.toHaveBeenCalled();
    await watcher.check(at('19:15'));
    expect(end).toHaveBeenCalledWith('m1', null);
  });

  it('vocal vidé avant l’heure de fin : pas de clôture avant la fin prévue + délai', async () => {
    const { watcher, end, setPeople } = setup();
    setPeople([{ bot: false }]);
    await watcher.check(at('18:01'));
    setPeople([]);
    await watcher.check(at('18:10'));
    await watcher.check(at('19:04'));
    expect(end).not.toHaveBeenCalled();
    await watcher.check(at('19:05'));
    expect(end).toHaveBeenCalledOnce();
  });

  it('seul le bot (enregistrement) dans le vocal : compte comme vide', async () => {
    const { watcher, end, setPeople } = setup();
    setPeople([{ bot: true }]);
    await watcher.check(at('19:05'));
    expect(end).toHaveBeenCalledOnce();
  });

  it('réunion sans salon (création échouée) : nouvel essai, puis clôture après la fin prévue', async () => {
    const { watcher, end, ensureVoice } = setup({ ...live, voiceChannelId: null });
    await watcher.check(at('18:30'));
    expect(ensureVoice).toHaveBeenCalledWith('m1');
    expect(end).not.toHaveBeenCalled();
    await watcher.check(at('19:05'));
    expect(end).toHaveBeenCalledOnce();
  });

  it('salons temporaires des réunions finies : transmis pour suppression', async () => {
    const ended = { ...live, id: 'm2', status: 'ended', voiceTemporary: true } as MeetingRow;
    const { watcher, deleteTemporaryVoice, setPeople } = setup(live, [ended]);
    setPeople([{ bot: false }]);
    await watcher.check(at('18:30'));
    expect(deleteTemporaryVoice).toHaveBeenCalledWith(ended);
  });
});
