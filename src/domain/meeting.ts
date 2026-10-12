import { DateTime } from 'luxon';
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

/** Nom du post de forum : « Lun. 12/10 · 18h00 · Titre » (100 caractères max côté Discord). */
export function threadName(title: string, startsAt: Date, zone: string, locale: string): string {
  const start = DateTime.fromJSDate(startsAt, { zone }).setLocale(locale);
  const weekday = start.toFormat('ccc');
  const prefix = `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${start.toFormat("dd/MM · HH'h'mm")}`;
  const name = `${prefix} · ${title}`;
  return name.length <= 100 ? name : `${name.slice(0, 99)}…`;
}

/**
 * Clôture automatique d'une réunion en cours : uniquement quand le vocal est vide, jamais parce
 * que l'heure de fin prévue est dépassée (une réunion peut déborder). Le délai de grâce court
 * depuis le départ de la dernière personne ; si personne n'est jamais venu, depuis la fin prévue.
 */
export function shouldCloseForEmpty(input: {
  humansPresent: number;
  /** Dernière fois qu'une personne a été vue dans le vocal (null : jamais vue). */
  lastHumanAt: Date | null;
  plannedEnd: Date;
  now: Date;
  graceMin: number;
}): boolean {
  if (input.humansPresent > 0) return false;
  const since = input.lastHumanAt ?? input.plannedEnd;
  return input.now.getTime() - since.getTime() >= input.graceMin * 60_000;
}
