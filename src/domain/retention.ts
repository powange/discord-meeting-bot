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

/**
 * Pistes brutes à supprimer : réunion close, session terminée depuis plus de `days` jours, et
 * audio complet + transcription faits (ou session sans aucune parole). Jamais une réunion
 * ouverte ou un traitement en échec ou inachevé.
 */
export function rawTracksToPurge(candidates: readonly RawCandidate[], now: Date): string[] {
  return candidates
    .filter((c) => c.days > 0 && !c.purgedAt && c.endedAt)
    .filter((c) => c.meetingStatus === 'ended' || c.meetingStatus === 'cancelled')
    .filter((c) => now.getTime() - c.endedAt!.getTime() >= c.days * DAY)
    .filter((c) => !c.hasSegments || (c.mix === 'done' && c.transcribe === 'done'))
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
