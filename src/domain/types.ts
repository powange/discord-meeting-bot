/** « polling » : date pas encore fixée, sondage de disponibilités en cours. */
export const MEETING_STATUSES = ['scheduled', 'live', 'ended', 'cancelled', 'polling'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const RSVP_STATUSES = ['yes', 'maybe', 'no'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export const JOB_KINDS = ['reminder', 'start', 'auto_end', 'record_start', 'voice_create', 'poll_nudge', 'poll_close'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface StatusTagIds {
  upcoming: string;
  live: string;
  ended: string;
  cancelled: string;
  /** Ajouté avec les sondages de date : absent des forums configurés avant. */
  polling?: string;
}

export interface Rsvp {
  userId: string;
  status: RsvpStatus;
  updatedAt: Date;
}

export interface AgendaItem {
  id: number;
  position: number;
  title: string;
  detail: string;
  authorId: string;
}

export const RECORDING_STATUSES = ['recording', 'stopped', 'interrupted', 'failed'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

/** Raison de fin d'un enregistrement. */
export type StopReason = 'manual' | 'empty' | 'meeting_end' | 'shutdown' | 'disconnected';

/**
 * Étapes du traitement post-réunion, dans l'ordre d'exécution. Le mix passe en premier : l'audio
 * est publié même si la transcription ou le résumé échouent. La copie vers le stockage du serveur
 * (Google Drive, OneDrive, Dropbox) vient après la publication : un échec ne retarde pas le compte rendu.
 */
export const PIPELINE_STEPS = ['mix', 'transcribe', 'summarize', 'publish', 'export'] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const STEP_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
