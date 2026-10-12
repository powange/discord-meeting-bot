export const MEETING_STATUSES = ['scheduled', 'live', 'ended', 'cancelled'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const RSVP_STATUSES = ['yes', 'maybe', 'no'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export const JOB_KINDS = ['reminder', 'start', 'auto_end'] as const;
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
