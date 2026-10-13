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
