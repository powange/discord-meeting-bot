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
