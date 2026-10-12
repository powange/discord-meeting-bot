/**
 * Debug (phase 2) : reconstitue, pour une session d'enregistrement, une piste continue par
 * participant (prises de parole replacées à leur instant, silence entre elles) et un mix.
 *
 *   npx tsx --env-file=.env scripts/assemble.ts <recordingId>
 *
 * Nécessite ffmpeg (variable FFMPEG, sinon `ffmpeg` du PATH). Sortie : <dataDir>/assembled/.
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createDb } from '../src/db/client.js';
import { Repositories } from '../src/db/repositories.js';

const recordingId = process.argv[2];
if (!recordingId) {
  console.error('Usage : scripts/assemble.ts <recordingId>');
  process.exit(1);
}

const ffmpegBin = process.env.FFMPEG ?? 'ffmpeg';
const config = loadConfig();
const { db, pool } = createDb(config.database.url);
const repos = new Repositories(db);

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg a échoué (code ${code})`))));
  });
}

/** Place chaque segment à son instant (adelay) puis les additionne : piste continue. */
async function place(inputs: Array<{ file: string; startMs: number }>, output: string): Promise<void> {
  const args = inputs.flatMap((i) => ['-i', i.file]);
  const delays = inputs.map((i, n) => `[${n}:a]adelay=${i.startMs}:all=1[d${n}]`);
  const mix = `${inputs.map((_, n) => `[d${n}]`).join('')}amix=inputs=${inputs.length}:normalize=0:dropout_transition=0[out]`;
  await ffmpeg([...args, '-filter_complex', [...delays, mix].join(';'), '-map', '[out]', '-ar', '48000', '-c:a', 'libopus', '-b:a', '64k', output]);
}

try {
  const recording = await repos.getRecording(recordingId);
  if (!recording) throw new Error(`Session ${recordingId} introuvable`);
  const segments = await repos.listSegments(recordingId);
  if (segments.length === 0) throw new Error('Aucune prise de parole dans cette session');

  const outDir = join(recording.dataDir, 'assembled');
  await mkdir(outDir, { recursive: true });
  const byUser = Map.groupBy(segments, (s) => s.userId);
  for (const [userId, list] of byUser) {
    const out = join(outDir, `${userId}.ogg`);
    await place(list.map((s) => ({ file: s.filePath, startMs: s.startMs })), out);
    console.log(`${userId} : ${list.length} prise(s) de parole → ${out}`);
  }
  const mixOut = join(outDir, 'mix.ogg');
  await place([...byUser.keys()].map((u) => ({ file: join(outDir, `${u}.ogg`), startMs: 0 })), mixOut);
  console.log(`Mix → ${mixOut}`);
} finally {
  await pool.end();
}
