import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import type { GuildSettingsRow, MeetingRow } from '../src/db/schema.js';
import { messages } from '../src/i18n/index.js';
import { UserError } from '../src/lib/errors.js';
import { RecordingService } from '../src/services/recordings.js';

// Connexion vocale simulée : on choisit si elle aboutit (Ready) ou expire.
const voice = vi.hoisted(() => ({ ready: true, connections: [] as Array<{ destroy: ReturnType<typeof import('vitest').vi.fn> }> }));
vi.mock('@discordjs/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@discordjs/voice')>();
  return {
    ...actual,
    joinVoiceChannel: () => {
      const connection = { destroy: vi.fn(), on: vi.fn(), receiver: { speaking: { on: vi.fn(), off: vi.fn(), onPacket: vi.fn() } } };
      voice.connections.push(connection);
      return connection;
    },
    entersState: async () => {
      if (!voice.ready) throw new Error('timeout');
    },
  };
});

const m = messages('fr');
let dataDir: string;
const meeting = { id: 'm1', guildId: 'g', status: 'live', voiceChannelId: 'v', title: 'Bureau', threadId: null } as MeetingRow;
const settings = { guildId: 'g', locale: 'fr' } as GuildSettingsRow;

function service(insertRecording: () => Promise<unknown> = async () => undefined) {
  const channel = { id: 'v', isVoiceBased: () => true, permissionsFor: () => ({ has: () => true }), members: new Map() };
  const guild = { id: 'g', channels: { fetch: async () => channel }, members: { me: { nickname: null } }, voiceAdapterCreator: () => undefined };
  const config = buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' }, dataDir, diskMinFreeGb: 0 }, {});
  return new RecordingService(
    { guilds: { fetch: async () => guild } } as never,
    { getMeeting: async () => meeting, insertRecording } as never,
    { get: async () => settings, messages: async () => m } as never,
    { refresh: () => undefined } as never,
    config,
    pino({ level: 'silent' }),
    { load: async () => undefined, isOptedOut: () => false } as never,
  );
}

describe('démarrage d’un enregistrement', () => {
  beforeEach(async () => {
    voice.ready = true;
    voice.connections.length = 0;
    dataDir ??= await mkdtemp(join(tmpdir(), 'mr-rec-'));
  });
  afterAll(async () => rm(dataDir, { recursive: true, force: true }));

  it('connexion au vocal expirée : message clair, connexion détruite, serveur libéré pour un nouvel essai', async () => {
    voice.ready = false;
    const recordings = service();
    await expect(recordings.start('m1', 'u')).rejects.toThrow(m.errors.voiceJoinFailed);
    expect(voice.connections[0]!.destroy).toHaveBeenCalled();
    expect(recordings.isRecording('m1')).toBe(false);
    // Le serveur n'est pas resté « occupé » : un nouvel essai tente bien une nouvelle connexion.
    await expect(recordings.start('m1', 'u')).rejects.toBeInstanceOf(UserError);
    expect(voice.connections).toHaveLength(2);
  });

  it('échec après la connexion (base indisponible) : le bot quitte le vocal', async () => {
    const recordings = service(async () => Promise.reject(new Error('base indisponible')));
    await expect(recordings.start('m1', 'u')).rejects.toThrow('base indisponible');
    expect(voice.connections[0]!.destroy).toHaveBeenCalled();
    expect(recordings.isRecording('m1')).toBe(false);
  });
});

describe('message à boutons : toujours le dernier message de l’enregistrement', async () => {
  const { fakeThread } = await import('./helpers/discordFakes.js');

  /** Réunion en cours, une personne dans le vocal ; sessions et réunion modifiables par le test. */
  function setup() {
    const t = fakeThread('post');
    let current = { ...meeting, threadId: 'post', status: 'live', controlMessageId: null, controlState: null } as unknown as MeetingRow;
    const sessions: Array<Record<string, unknown>> = [];
    const voiceChannel = { isVoiceBased: () => true, members: new Map([['u1', { user: { bot: false } }]]) };
    voiceChannel.members = Object.assign(voiceChannel.members, { filter: (fn: (x: { user: { bot: boolean } }) => boolean) => ({ size: [...voiceChannel.members.values()].filter(fn).length }) });
    const guild = { members: { fetch: async (id: string) => ({ displayName: id === 'u1' ? 'Pierre Comble' : id }) } };
    const svc = new RecordingService(
      { channels: { fetch: async () => t.thread, cache: new Map([['v', voiceChannel]]) }, guilds: { fetch: async () => guild } } as never,
      {
        getMeeting: async () => current,
        updateMeeting: async (_id: string, patch: Partial<MeetingRow>) => void (current = { ...current, ...patch }),
        listRecordingsForMeeting: async () => sessions,
        listAgenda: async () => [{ id: 10, title: 'Budget' }],
        listMarkers: async () => [],
      } as never,
      { get: async () => settings, messages: async () => m } as never,
      { refresh: () => undefined } as never,
      buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
      pino({ level: 'silent' }),
      { load: async () => undefined, isOptedOut: () => false } as never,
    );
    const contentOf = (i: number) => { const e = (t.sent[i]!.embeds as Array<{ title?: string; description?: string }>)[0]!; return `${e.title}\n${e.description}`; };
    const hasButtons = (msgId: string) => {
      const edits = t.edited.filter((e) => e.id === msgId);
      return edits.length ? (edits.at(-1)!.components as unknown[]).length > 0 : true;
    };
    return { svc, t, sessions, meeting: () => current, setMeeting: (p: Partial<MeetingRow>) => (current = { ...current, ...p }), contentOf, hasButtons };
  }

  it('non démarré → en cours → arrêté → repris → réunion close', async () => {
    const s = setup();
    await s.svc.syncControl('m1');
    expect(s.contentOf(0)).toContain(m.control.embed.idleTitle);
    expect(s.meeting().controlState).toBe('idle');

    // Démarrage : « non démarré » supprimé, l'avertissement porte Arrêter, le suivi de l'ODJ en dessous.
    s.sessions.push({ id: 'r1', status: 'recording', startedAt: new Date(), endedAt: null, startedBy: 'u1', stoppedBy: null, stopReason: null });
    await s.svc.syncControl('m1');
    expect(s.t.deleted).toEqual(['msg1']);
    expect(s.contentOf(1)).toContain(`${m.control.embed.recTitle}\nLancé par **Pierre Comble**`);
    expect(JSON.stringify(s.t.sent[1]!.components)).toContain('rec:stop');
    expect(s.contentOf(2)).toContain(m.control.liveTitle);
    expect(JSON.stringify(s.t.sent[2]!.components)).toContain('rec:next');

    // Mise à jour pendant l'enregistrement (point suivant…) : mêmes messages, édités.
    await s.svc.syncControl('m1');
    expect(s.t.sent).toHaveLength(3);

    // Arrêt manuel : avertissement et suivi perdent leurs boutons, « arrêté par » porte Reprendre.
    Object.assign(s.sessions[0]!, { status: 'stopped', endedAt: new Date(), stoppedBy: 'u1', stopReason: 'manual' });
    await s.svc.syncControl('m1');
    expect(s.hasButtons('msg2')).toBe(false);
    expect(s.hasButtons('msg3')).toBe(false);
    expect(s.contentOf(3)).toBe(`${m.control.embed.stoppedTitle}\nPar **Pierre Comble**.`);
    expect(JSON.stringify(s.t.sent[3]!.components)).toContain('rec:start');

    // Reprise : nouvelle session, nouveaux messages en bas ; « arrêté » perd son bouton.
    s.sessions.push({ id: 'r2', status: 'recording', startedAt: new Date(), endedAt: null, startedBy: null, stoppedBy: null, stopReason: null });
    await s.svc.syncControl('m1');
    expect(s.hasButtons('msg4')).toBe(false);
    expect(s.contentOf(4)).toContain('Démarrage automatique');
    expect(s.contentOf(5)).toContain(m.control.liveTitle);

    // Réunion close : plus aucun bouton, plus de nouveau message.
    Object.assign(s.sessions[1]!, { status: 'stopped', endedAt: new Date(), stopReason: 'meeting_end' });
    s.setMeeting({ status: 'ended' });
    await s.svc.syncControl('m1');
    expect(s.hasButtons('msg5')).toBe(false);
    expect(s.hasButtons('msg6')).toBe(false);
    expect(s.t.sent).toHaveLength(6);
  });
});
