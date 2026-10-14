import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import type { GuildSettingsRow, MeetingRow } from '../src/db/schema.js';
import { handleAction } from '../src/discord/interactions/components.js';
import { OFF_AGENDA } from '../src/discord/embeds/recordingControl.js';
import type { Action } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';
import { fakeInteraction, spyObject, type InteractionKind } from './helpers/discordFakes.js';

const m = messages('fr');
const meetingId = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
const meeting = {
  id: meetingId, guildId: 'g', threadId: 't', title: 'Bureau', description: '', status: 'live', organizerId: 'organizer',
  startsAt: new Date(), durationMin: 60, voiceChannelId: 'v', voiceTemporary: false, autoRecord: false, agendaLocked: false,
} as MeetingRow;
const settings = { guildId: 'g', locale: 'fr', timezone: 'Europe/Paris', managerRoleIds: ['managers'] } as unknown as GuildSettingsRow;
const agenda = [
  { id: 10, title: 'Budget', detail: '', position: 0, authorId: 'x' },
  { id: 11, title: 'Fête', detail: '', position: 1, authorId: 'x' },
];

function setup(opts: { recording?: boolean; markers?: Array<{ kind: string; agendaItemId: number | null; at: Date }> } = {}) {
  const added: Array<Record<string, unknown>> = [];
  const recordings = spyObject({ isRecording: () => true, syncControl: vi.fn(async () => undefined) });
  const ctx = {
    config: buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
    log: pino({ level: 'silent' }),
    settings: { get: async () => settings, messages: async () => m },
    owners: { isOwner: () => false },
    client: {},
    recordings,
    meetings: spyObject(),
    pipeline: spyObject(),
    cards: spyObject(),
    hub: spyObject(),
    optouts: spyObject(),
    repos: spyObject({
      getMeeting: async () => meeting,
      getActiveRecording: async () => (opts.recording === false ? undefined : { id: 'r' }),
      listAgenda: async () => agenda,
      listMarkers: async () => (opts.markers ?? []).map((mk) => ({ ...mk, text: '', who: null })),
      addMarker: vi.fn(async (v: Record<string, unknown>) => void added.push(v)),
    }),
  };
  const run = async (type: Action['type'], kind: InteractionKind, extra: { userId?: string; values?: string[]; fields?: Record<string, string> } = {}) => {
    const { interaction, lastText } = fakeInteraction({ kind, userId: extra.userId ?? 'organizer', ...(extra.values ? { values: extra.values } : {}), ...(extra.fields ? { fields: extra.fields } : {}) });
    const error = await handleAction(ctx as never, interaction as never, { type, meetingId } as never).then(
      () => null,
      (err: Error) => err.message,
    );
    return { error, text: lastText() };
  };
  return { run, added, recordings };
}

describe('repères pendant l’enregistrement', () => {
  it('« Point suivant » : premier point, puis le suivant ; message d’enregistrement mis à jour', async () => {
    const first = setup();
    expect((await first.run('rec.next', 'button')).text).toBe('▶️ Repère posé : 1. Budget.');
    expect(first.added[0]).toMatchObject({ meetingId, kind: 'agenda', agendaItemId: 10, authorId: 'organizer' });
    expect(first.recordings.syncControl).toHaveBeenCalledWith(meetingId);
    const second = setup({ markers: [{ kind: 'agenda', agendaItemId: 10, at: new Date() }] });
    await second.run('rec.next', 'button');
    expect(second.added[0]).toMatchObject({ agendaItemId: 11 });
  });

  it('choix direct d’un point, ou « hors ordre du jour »', async () => {
    const s = setup();
    await s.run('rec.goto', 'select', { values: ['11'] });
    await s.run('rec.goto', 'select', { values: [OFF_AGENDA] });
    expect(s.added.map((a) => a.agendaItemId)).toEqual([11, null]);
  });

  it('note : n’importe quel participant, type, texte et responsable (pour une action seulement)', async () => {
    const s = setup();
    const r = await s.run('rec.noteSubmit', 'modal', { userId: 'member', fields: { kind: 'action', text: ' Réserver la salle ', who: 'Marie' } });
    expect(r.text).toBe(m.control.noteSaved);
    await s.run('rec.noteSubmit', 'modal', { userId: 'member', fields: { kind: 'decision', text: 'Budget adopté', who: 'ignoré' } });
    expect(s.added).toMatchObject([
      { kind: 'action', text: 'Réserver la salle', who: 'Marie', authorId: 'member' },
      { kind: 'decision', text: 'Budget adopté', who: null },
    ]);
  });

  it('hors enregistrement : refusé, rien n’est noté', async () => {
    const s = setup({ recording: false });
    expect((await s.run('rec.next', 'button')).error).toBe(m.control.notRecording);
    expect((await s.run('rec.note', 'button', { userId: 'member' })).error).toBe(m.control.notRecording);
    expect(s.added).toEqual([]);
    expect(s.recordings.syncControl).toHaveBeenCalledWith(meetingId); // message resté d'avant un redémarrage : remis à jour
  });

  it('« Arrêter » alors que rien n’enregistre (bot redémarré) : message remis à jour, pas d’erreur', async () => {
    const s = setup({ recording: false });
    const r = await s.run('rec.stop', 'button');
    expect(r.error).toBeNull();
    expect(r.text).toBe(m.recording.alreadyStopped);
    expect(s.recordings.syncControl).toHaveBeenCalledWith(meetingId);
  });
});
