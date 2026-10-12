import type { MeetingStatus } from './types.js';

const TRANSITIONS: Record<MeetingStatus, readonly MeetingStatus[]> = {
  scheduled: ['live', 'ended', 'cancelled'],
  live: ['ended', 'cancelled'],
  ended: [],
  cancelled: [],
};

export function canTransition(from: MeetingStatus, to: MeetingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Réunion encore « vivante » : RSVP et ODJ modifiables. */
export function isOpen(status: MeetingStatus): boolean {
  return status === 'scheduled' || status === 'live';
}

/** Date, durée et salon ne se modifient qu'avant le début. */
export function canReschedule(status: MeetingStatus): boolean {
  return status === 'scheduled';
}

export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 2000;
export const DURATION_MIN = 5;
export const DURATION_MAX = 24 * 60;

/** Nom du post de forum : « 15/10 · Titre » (100 caractères max côté Discord). */
export function threadName(title: string, dayMonth: string): string {
  const name = `${dayMonth} · ${title}`;
  return name.length <= 100 ? name : `${name.slice(0, 99)}…`;
}
