import { spawn } from 'node:child_process';
import { setPriority } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';

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
    // Priorité basse : le mix et la préparation des blocs ne doivent pas ralentir la réception
    // vocale en direct (même processus pour tous les serveurs).
    if (proc.pid) {
      try {
        setPriority(proc.pid, 10);
      } catch {
        // Plateforme sans priorité de processus : sans conséquence.
      }
    }
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

/** Au-delà, les entrées sont mixées par paquets (fichiers intermédiaires FLAC). */
const MAX_INPUTS_PER_PASS = 48;

export interface PlacedInput {
  file: string;
  offsetMs: number;
  /**
   * Piste à laquelle appartient le fichier (une personne) : ses fichiers ne se chevauchent pas et
   * sont d'abord mis bout à bout. Sans piste, le fichier est mixé tel quel (mix précédent).
   */
  track?: string;
}

/**
 * Superpose des fichiers audio placés à leur instant (ce que tout le monde a entendu), en un
 * fichier encodé avec `encodeArgs`. Les grandes réunions sont mixées par paquets pour ne pas
 * ouvrir des centaines de fichiers d'un coup ; une limite douce évite la saturation quand
 * plusieurs personnes parlent ensemble.
 */
export async function mixPlaced(
  bin: string,
  inputs: readonly PlacedInput[],
  output: string,
  encodeArgs: readonly string[],
  tmpDir: string,
  signal?: AbortSignal,
): Promise<void> {
  if (inputs.length === 0) throw new Error('Aucune piste à mixer');
  // Une piste continue par personne (coût proportionnel à la durée), puis un mix de ces pistes :
  // sans cela chaque prise de parole serait étirée sur toute la réunion (silence de tête) et le
  // mix additionnerait des centaines de flux sur toute la durée.
  const byTrack = new Map<string, PlacedInput[]>();
  let current: PlacedInput[] = [];
  for (const input of inputs) {
    if (input.track === undefined) current.push(input);
    else byTrack.set(input.track, [...(byTrack.get(input.track) ?? []), input]);
  }
  let n = 0;
  for (const list of byTrack.values()) {
    current.push(await sequence(bin, [...list].sort((a, b) => a.offsetMs - b.offsetMs), join(tmpDir, `piste-${n++}`), signal));
  }
  let pass = 0;
  while (current.length > MAX_INPUTS_PER_PASS) {
    const next: PlacedInput[] = [];
    for (let i = 0; i < current.length; i += MAX_INPUTS_PER_PASS) {
      const file = join(tmpDir, `mix-${pass}-${i / MAX_INPUTS_PER_PASS}.flac`);
      await mixOnce(bin, current.slice(i, i + MAX_INPUTS_PER_PASS), file, ['-ac', '1', '-ar', '48000', '-c:a', 'flac'], false, signal);
      next.push({ file, offsetMs: 0 }); // les intermédiaires partent tous de l'instant 0
    }
    current = next;
    pass++;
  }
  await mixOnce(bin, current, output, encodeArgs, true, signal);
}

/**
 * Fichiers d'une même piste mis bout à bout, chacun complété de silence (ou coupé) jusqu'au début
 * du suivant : durée exacte, sans dérive. Renvoie la piste, placée au début de son premier fichier.
 */
async function sequence(bin: string, list: readonly PlacedInput[], prefix: string, signal?: AbortSignal): Promise<PlacedInput> {
  if (list.length === 1) return list[0]!;
  if (list.length > MAX_INPUTS_PER_PASS) {
    const parts: PlacedInput[] = [];
    for (let i = 0; i < list.length; i += MAX_INPUTS_PER_PASS) {
      parts.push(await sequence(bin, list.slice(i, i + MAX_INPUTS_PER_PASS), `${prefix}-${i / MAX_INPUTS_PER_PASS}`, signal));
    }
    return sequence(bin, parts, `${prefix}-s`, signal);
  }
  const seconds = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);
  const pieces = list.map((input, i) => {
    const next = list[i + 1];
    const fit = next ? `,apad=whole_dur=${seconds(next.offsetMs - input.offsetMs)},atrim=end=${seconds(next.offsetMs - input.offsetMs)}` : '';
    return `[${i}:a]aformat=sample_rates=48000:channel_layouts=mono${fit}[p${i}]`;
  });
  const concat = `${list.map((_, i) => `[p${i}]`).join('')}concat=n=${list.length}:v=0:a=1[out]`;
  const file = `${prefix}.flac`;
  await runFfmpeg(bin, [...list.flatMap((i) => ['-i', i.file]), '-filter_complex', [...pieces, concat].join(';'), '-map', '[out]', '-c:a', 'flac', file], signal);
  return { file, offsetMs: list[0]!.offsetMs };
}

async function mixOnce(bin: string, inputs: readonly PlacedInput[], output: string, encodeArgs: readonly string[], limit: boolean, signal?: AbortSignal) {
  const args = inputs.flatMap((i) => ['-i', i.file]);
  const placed = inputs.map((i, n) => `[${n}:a]adelay=${Math.max(0, Math.round(i.offsetMs))}:all=1[a${n}]`);
  const tail = limit ? ',alimiter=limit=0.95' : '';
  const mix =
    inputs.length === 1
      ? `[a0]anull${tail}[out]`
      : `${inputs.map((_, n) => `[a${n}]`).join('')}amix=inputs=${inputs.length}:normalize=0:dropout_transition=0${tail}[out]`;
  await runFfmpeg(bin, [...args, '-filter_complex', [...placed, mix].join(';'), '-map', '[out]', ...encodeArgs, output], signal);
}

/** Découpe un fichier audio en parties de `partMs`, sans réencodage. Renvoie les chemins. */
export async function splitAudio(bin: string, input: string, partMs: number, parts: number, outputFor: (index: number) => string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  for (let i = 0; i < parts; i++) {
    const out = outputFor(i);
    await runFfmpeg(bin, ['-i', input, '-ss', String((i * partMs) / 1000), '-t', String(partMs / 1000), '-c', 'copy', out], signal);
    files.push(out);
  }
  return files;
}
