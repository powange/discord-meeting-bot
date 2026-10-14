import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SegmentWriter } from '../src/recording/segmentWriter.js';

const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

describe('SegmentWriter : erreurs d’écriture', () => {
  it('une erreur d’écriture ne fait pas planter le processus : les paquets sont ignorés et close() échoue proprement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mr-writer-'));
    dirs.push(dir);
    // Un dossier à la place du fichier : l'ouverture échoue de façon asynchrone (EISDIR), comme un disque plein.
    const writer = SegmentWriter.open(dir);
    await new Promise((r) => setTimeout(r, 50));
    expect(writer.failed).toBe(true);
    writer.write(Buffer.from([0xf8, 0xff, 0xfe]));
    expect(writer.packetCount).toBe(0);
    await expect(writer.close()).rejects.toThrow(/Écriture de la piste impossible/);
  });

  it('cas normal : fichier fermé avec ses paquets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mr-writer-'));
    dirs.push(dir);
    const writer = SegmentWriter.open(join(dir, 'a.ogg'));
    writer.write(Buffer.from([0xf8, 0xff, 0xfe]), 1000);
    writer.write(Buffer.from([0xf8, 0xff, 0xfe]), 1020);
    await expect(writer.close()).resolves.toMatchObject({ packets: 2, firstPacketAt: 1000, lastPacketAt: 1020 });
  });
});

describe('SegmentWriter : silences comblés d’après le temps réel', () => {
  const frame = Buffer.from([0xf8, 0xff, 0xfe]); // 20 ms
  const open = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mr-writer-'));
    dirs.push(dir);
    return SegmentWriter.open(join(dir, 'a.ogg'));
  };

  it('pause de 500 ms comblée', async () => {
    const w = await open();
    w.write(frame, 0);
    w.write(frame, 520);
    expect(w.writtenMs).toBe(540);
    await w.close();
  });

  it('paquets retardés puis en rafale : l’écart ne s’accumule pas et se résorbe à la pause suivante', async () => {
    const w = await open();
    const burst = (from: number) => {
      // 200 ms de blocage, puis les 10 paquets retenus arrivent d'un coup.
      for (let i = 0; i < 10; i++) w.write(frame, from + i);
    };
    for (let i = 0; i < 10; i++) w.write(frame, i * 20); // 0 → 200 ms
    burst(400);
    const afterFirst = w.writtenMs;
    for (let i = 0; i < 10; i++) w.write(frame, 420 + i * 20); // reprise : 420 → 620 ms
    burst(820); // second incident : pas de nouveau silence (le fichier est déjà en avance)
    expect(w.writtenMs - afterFirst).toBe(400);
    // Vraie pause jusqu'à 3 s : comblée de ce qui manque seulement, la durée rejoint le temps réel.
    w.write(frame, 3000);
    expect(w.writtenMs).toBe(3020);
    await w.close();
  });

  it('pause plus longue que le plafond : comblée une fois, sans rattrapage ensuite', async () => {
    const w = await open();
    w.write(frame, 0);
    w.write(frame, 20_000); // 20 s : plafonné à 5 s de silence
    const after = w.writtenMs;
    w.write(frame, 20_020);
    expect(w.writtenMs - after).toBe(20);
    await w.close();
  });
});
