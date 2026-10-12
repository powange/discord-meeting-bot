import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

let resolved: string | undefined;

/**
 * Binaire ffmpeg : celui de la config, sinon `ffmpeg-static` (dépendance de développement,
 * absente de l'image Docker), sinon `ffmpeg` du PATH (installé dans l'image).
 */
export function ffmpegPath(configured?: string): string {
  if (configured) return configured;
  if (resolved) return resolved;
  try {
    const path = createRequire(import.meta.url)('ffmpeg-static') as string | null;
    resolved = path ?? 'ffmpeg';
  } catch {
    resolved = 'ffmpeg';
  }
  return resolved;
}

export function runFfmpeg(bin: string, args: readonly string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg (code ${code}) : ${stderr.trim()}`))));
  });
}

/**
 * Assemble des fichiers audio placés à leur instant (`offsetMs`) en un WAV mono 16 kHz, le
 * format attendu par Whisper.
 */
export async function assembleWav(bin: string, inputs: ReadonlyArray<{ file: string; offsetMs: number }>, output: string, signal?: AbortSignal): Promise<void> {
  const args = inputs.flatMap((i) => ['-i', i.file]);
  const placed = inputs.map((i, n) => `[${n}:a]adelay=${Math.max(0, Math.round(i.offsetMs))}:all=1[a${n}]`);
  const mix =
    inputs.length === 1 ? `[a0]anull[out]` : `${inputs.map((_, n) => `[a${n}]`).join('')}amix=inputs=${inputs.length}:normalize=0:dropout_transition=0[out]`;
  await runFfmpeg(bin, [...args, '-filter_complex', [...placed, mix].join(';'), '-map', '[out]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output], signal);
}
