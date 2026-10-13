import type { MeetingStatus, StepStatus } from './types.js';

const DAY = 86_400_000;

export interface RawCandidate {
  recordingId: string;
  meetingStatus: MeetingStatus;
  endedAt: Date | null;
  purgedAt: Date | null;
  /** Statuts des étapes mix et transcribe de la réunion (absentes : pas de traitement). */
  mix: StepStatus | null;
  transcribe: StepStatus | null;
  hasSegments: boolean;
  days: number;
}

const processed = (c: RawCandidate) => !c.hasSegments || (c.mix === 'done' && c.transcribe === 'done');
const purgeable = (c: RawCandidate) => c.days > 0 && !c.purgedAt && c.endedAt !== null && (c.meetingStatus === 'ended' || c.meetingStatus === 'cancelled');
const ageDays = (c: RawCandidate, now: Date) => (now.getTime() - c.endedAt!.getTime()) / DAY;

/**
 * Pistes brutes à supprimer : réunion close, session terminée depuis plus de `days` jours, et
 * audio complet + transcription faits (ou session sans aucune parole). Un traitement resté en
 * échec garde ses pistes deux fois plus longtemps (le temps de le relancer), puis elles sont
 * supprimées aussi : sinon elles resteraient à vie. Jamais une réunion ouverte.
 */
export function rawTracksToPurge(candidates: readonly RawCandidate[], now: Date): string[] {
  return candidates
    .filter(purgeable)
    .filter((c) => ageDays(c, now) >= (processed(c) ? c.days : 2 * c.days))
    .map((c) => c.recordingId);
}

/** Pistes d'un traitement en échec qui seront supprimées dans moins d'un jour (pour prévenir). */
export function unprocessedTracksExpiringSoon(candidates: readonly RawCandidate[], now: Date): string[] {
  return candidates
    .filter(purgeable)
    .filter((c) => !processed(c))
    .filter((c) => ageDays(c, now) >= 2 * c.days - 1 && ageDays(c, now) < 2 * c.days)
    .map((c) => c.recordingId);
}

export interface MixCandidate {
  meetingId: string;
  file: string | null;
  finishedAt: Date | null;
  purged: boolean;
  days: number;
}

/** Audios complets plus anciens que `days` jours (copie locale ; celle publiée dans Discord reste). */
export function mixesToPurge(candidates: readonly MixCandidate[], now: Date): MixCandidate[] {
  return candidates.filter((c) => c.days > 0 && c.file && !c.purged && c.finishedAt && now.getTime() - c.finishedAt.getTime() >= c.days * DAY);
}
