import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { VoiceConnection } from '@discordjs/voice';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { RecordingSession } from '../src/recording/session.js';

/**
 * Faux récepteur reproduisant l'ordre réel de @discordjs/voice : onPacket (avant déchiffrement)
 * émet « start », puis le paquet, s'il est déchiffré, est poussé dans le flux de l'abonné.
 */
function fakeConnection() {
  const subscriptions = new Map<string, PassThrough>();
  const speaking = new EventEmitter() as EventEmitter & { onPacket(userId: string): void; active: Set<string> };
  speaking.active = new Set();
  speaking.onPacket = function (userId: string) {
    if (!speaking.active.has(userId)) {
      speaking.active.add(userId);
      speaking.emit('start', userId);
    }
  };
  const receiver = {
    speaking,
    subscribe(userId: string) {
      let s = subscriptions.get(userId);
      if (!s) {
        s = new PassThrough({ objectMode: true });
        s.once('close', () => subscriptions.delete(userId));
        subscriptions.set(userId, s);
      }
      return s;
    },
  };
  /** Un paquet arrive : compté par la bibliothèque, puis transmis seulement s'il est déchiffré. */
  const packet = (userId: string, decrypted: boolean) => {
    receiver.speaking.onPacket(userId);
    if (decrypted) subscriptions.get(userId)?.write(Buffer.from([0xf8, 0xff, 0xfe]));
  };
  const breakStream = (userId: string) => subscriptions.get(userId)?.destroy(new Error('DecryptionFailed'));
  return { connection: { receiver, destroy() {} } as unknown as VoiceConnection, packet, breakStream };
}

describe('RecordingSession — qualité de capture', () => {
  let dir: string;
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('compte les paquets reçus, écrits, et les flux interrompus ; ignore les non-enregistrés', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mb-session-'));
    const fake = fakeConnection();
    const segments: string[] = [];
    const session = new RecordingSession(fake.connection, {
      recordingId: 'r',
      dataDir: dir,
      silenceMs: 1000,
      log: pino({ level: 'silent' }),
      shouldRecord: (id) => id !== 'optout',
      onSegment: async (s) => void segments.push(s.userId),
    });

    for (let i = 0; i < 10; i++) fake.packet('alice', i % 5 < 3); // 6 déchiffrés sur 10
    for (let i = 0; i < 4; i++) fake.packet('optout', true);
    fake.breakStream('alice');
    await new Promise((r) => setTimeout(r, 20));
    await session.stop();

    expect(session.captureStats()).toEqual([{ userId: 'alice', receivedPackets: 10, writtenPackets: 6, streamErrors: 1 }]);
    expect(segments).toEqual(['alice']); // le segment interrompu est conservé
  });
});
