export const MEETING_STATUSES = ['scheduled', 'live', 'ended', 'cancelled'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const RSVP_STATUSES = ['yes', 'maybe', 'no'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export const JOB_KINDS = ['reminder', 'start', 'auto_end', 'record_start'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface StatusTagIds {
  upcoming: string;
  live: string;
  ended: string;
  cancelled: string;
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

/** Étapes du traitement post-réunion (la phase 4 ajoutera mix et upload). */
export const PIPELINE_STEPS = ['transcribe', 'summarize', 'publish'] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const STEP_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
