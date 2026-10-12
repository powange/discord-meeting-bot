import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ffmpegPath, mixPlaced, runFfmpeg, splitAudio } from '../src/lib/ffmpeg.js';
import { SegmentWriter } from '../src/recording/segmentWriter.js';

describe('mixPlaced (ffmpeg réel)', () => {
  let dir: string;
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('mixe par paquets au-delà de 48 pistes, durée fidèle à la ligne de temps', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mb-mix-'));
    const inputs = [];
    for (let i = 0; i < 60; i++) {
      const w = SegmentWriter.open(join(dir, `s${i}.ogg`));
      for (let f = 0; f < 25; f++) w.write(Buffer.from([0xf8, 0xff, 0xfe]), f * 20); // 0,5 s
      await w.close();
      inputs.push({ file: join(dir, `s${i}.ogg`), offsetMs: i * 1000 }); // la dernière finit à 59,5 s
    }
    const out = join(dir, 'mix.ogg');
    await mixPlaced(ffmpegPath(), inputs, out, ['-ac', '1', '-c:a', 'libopus', '-b:a', '24k'], dir);
    expect((await stat(out)).size).toBeGreaterThan(0);

    // Durée réelle : décodage complet, ffmpeg écrit « time=00:00:59.50 » à la fin.
    await runFfmpeg(ffmpegPath(), ['-v', 'error', '-i', out, '-f', 'null', '-']); // décodable sans erreur
    const { spawnSync } = await import('node:child_process');
    const log = spawnSync(ffmpegPath(), ['-i', out, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const time = /time=(\d+):(\d+):([\d.]+)/g;
    let last: RegExpExecArray | null = null;
    for (let m = time.exec(log); m; m = time.exec(log)) last = m;
    const seconds = Number(last![1]) * 3600 + Number(last![2]) * 60 + Number(last![3]);
    expect(seconds).toBeGreaterThan(59);
    expect(seconds).toBeLessThan(60.5);

    // Découpage en 3 parties de 20 s, sans réencodage, chacune décodable.
    const parts = await splitAudio(ffmpegPath(), out, 20_000, 3, (i) => join(dir, `part${i + 1}.ogg`));
    const durations = parts.map((p) => {
      const l = spawnSync(ffmpegPath(), ['-i', p, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
      const all = [...l.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].at(-1)!;
      return Number(all[2]) * 60 + Number(all[3]);
    });
    expect(durations.every((d) => d <= 20.1)).toBe(true);
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(seconds, 0); // rien de perdu ni de doublé
  }, 60_000);
});
