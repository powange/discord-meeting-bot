/** Logique pure de la transcription : blocs, nettoyage, fusion chronologique, découpage. */

export interface SegmentRef {
  id: number;
  userId: string;
  startMs: number;
  endMs: number;
}

export interface Block {
  userId: string;
  startMs: number;
  endMs: number;
  segments: SegmentRef[];
}

/**
 * Regroupe les prises de parole d'une même personne séparées de moins de `maxGapMs`, sans
 * dépasser `maxBlockMs` : moins de requêtes, plus de contexte pour Whisper, et peu de silence
 * (sur lequel Whisper a tendance à inventer du texte).
 */
export function buildBlocks(segments: readonly SegmentRef[], maxGapMs: number, maxBlockMs: number): Block[] {
  const blocks: Block[] = [];
  const byUser = new Map<string, SegmentRef[]>();
  for (const s of segments) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
  for (const [userId, list] of byUser) {
    let current: Block | null = null;
    for (const s of [...list].sort((a, b) => a.startMs - b.startMs)) {
      const fits = current && s.startMs - current.endMs <= maxGapMs && Math.max(current.endMs, s.endMs) - current.startMs <= maxBlockMs;
      if (current && fits) {
        current.endMs = Math.max(current.endMs, s.endMs);
        current.segments.push(s);
      } else {
        current = { userId, startMs: s.startMs, endMs: s.endMs, segments: [s] };
        blocks.push(current);
      }
    }
  }
  return blocks.sort((a, b) => a.startMs - b.startMs || a.userId.localeCompare(b.userId));
}

/**
 * Phrases que Whisper invente sur du silence ou du bruit (génériques de vidéos, sous-titres).
 * Comparaison sans casse ni ponctuation, sur le segment entier.
 */
const HALLUCINATIONS = [
  "sous-titres réalisés par la communauté d'amara.org",
  'sous-titrage st 501',
  'sous-titrage société radio-canada',
  "merci d'avoir regardé cette vidéo",
  "merci d'avoir regardé",
  'abonnez-vous',
  "n'oubliez pas de vous abonner",
  'thanks for watching',
  'thank you for watching',
  'subtitles by the amara.org community',
];
const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`´]/g, "'")
    .replace(/[^a-z0-9' -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const HALLUCINATION_SET = new Set(HALLUCINATIONS.map(normalize));

export interface RawSegment {
  start: number; // secondes, relatives au bloc
  end: number;
  text: string;
  noSpeechProb?: number | undefined;
}

/** Retire les segments vides, très probablement non parlés, ou hallucinés. */
export function cleanSegments(segments: readonly RawSegment[]): RawSegment[] {
  return segments
    .map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text.length > 0)
    .filter((s) => (s.noSpeechProb ?? 0) < 0.8)
    .filter((s) => !HALLUCINATION_SET.has(normalize(s.text)))
    .filter((s) => !/^[\s.…!?,-]*$/.test(s.text));
}

export interface TranscriptLine {
  userId: string;
  name: string;
  startAt: Date;
  text: string;
}

/**
 * Fusion chronologique, en regroupant les phrases successives d'une même personne en une
 * réplique (lecture plus naturelle, moins de tokens pour le résumé).
 */
export function mergeTranscript(lines: readonly TranscriptLine[], joinGapMs = 15_000): TranscriptLine[] {
  const sorted = [...lines].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const out: TranscriptLine[] = [];
  let lastAt = 0;
  for (const line of sorted) {
    const prev = out.at(-1);
    if (prev && prev.userId === line.userId && line.startAt.getTime() - lastAt <= joinGapMs) {
      prev.text = `${prev.text} ${line.text}`;
    } else {
      out.push({ ...line });
    }
    lastAt = line.startAt.getTime();
  }
  return out;
}

/** « 18:02:15 » dans le fuseau du serveur. */
export function formatClock(date: Date, zone: string): string {
  return date.toLocaleTimeString('fr-FR', { timeZone: zone, hour12: false });
}

/** « [18:02:15] Alice : texte », heure dans le fuseau du serveur. */
export function formatLine(line: TranscriptLine, zone: string): string {
  return `[${formatClock(line.startAt, zone)}] ${line.name} : ${line.text}`;
}

/** Estimation grossière (≈ 4 caractères par token) : suffisante pour dimensionner les passes. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Découpe une transcription en morceaux d'au plus `maxTokens`, sans couper une réplique. */
export function chunkLines(lines: readonly string[], maxTokens: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    const t = estimateTokens(line) + 1;
    if (current.length > 0 && size + t > maxTokens) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += t;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
