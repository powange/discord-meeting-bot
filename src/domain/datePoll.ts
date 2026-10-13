import { DateTime } from 'luxon';
import { DURATION_MAX, DURATION_MIN } from './meeting.js';
import { combineDayTime, parseDatedRange } from './time.js';
import type { RsvpStatus } from './types.js';

/**
 * Sondage de date (grille de disponibilités, comme Framadate) : plusieurs créneaux proposés,
 * chacun répond « disponible », « si nécessaire » ou « pas disponible » pour chacun.
 */

export const SLOTS_MIN = 2;
/** Limite des composants Discord du panneau de réponse (2 par créneau). */
export const SLOTS_MAX = 10;

/** Réponse à un créneau : mêmes valeurs que les inscriptions (Présent / Peut-être / Absent). */
export type Availability = RsvpStatus;

export interface SlotInput {
  startsAt: Date;
  durationMin: number;
}

export type SlotsResult =
  | { ok: true; slots: SlotInput[] }
  | { ok: false; error: 'count' | 'format' | 'invalid' | 'past' | 'duplicate' | 'duration'; line?: number };

/**
 * Créneaux saisis un par ligne, aux formats de « Autre date » : « 21/10 18h », « mar 21/10
 * 18h-19h30 », « 15 janv. 18h ». Sans heure de fin : durée par défaut. Triés par date.
 */
export function parseSlots(input: string, zone: string, now: Date, defaultDurationMin: number): SlotsResult {
  const lines = input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < SLOTS_MIN || lines.length > SLOTS_MAX) return { ok: false, error: 'count' };
  const slots: SlotInput[] = [];
  for (const [i, raw] of lines.entries()) {
    const one = parseSlotLine(raw, zone, now, defaultDurationMin);
    if (!one.ok) return { ok: false, error: one.error, line: i + 1 };
    if (slots.some((s) => s.startsAt.getTime() === one.slot.startsAt.getTime())) return { ok: false, error: 'duplicate', line: i + 1 };
    slots.push(one.slot);
  }
  return { ok: true, slots: slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()) };
}

/** Un créneau saisi (« mar 21/10 18h-19h30 ») ; sans heure de fin, durée par défaut. */
export function parseSlotLine(
  raw: string,
  zone: string,
  now: Date,
  defaultDurationMin: number,
): { ok: true; slot: SlotInput } | { ok: false; error: 'format' | 'invalid' | 'past' | 'duration' } {
  // Jour de la semaine en tête facultatif (« mar 21/10 18h ») : seule la date fait foi.
  const line = raw.trim().replace(/^(lun|mar|mer|jeu|ven|sam|dim)[a-z.]*\s+/i, '');
  const parsed = parseDatedRange(line, zone, DateTime.fromJSDate(now));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const startsAt = combineDayTime(parsed.day, parsed.hour, parsed.minute, zone);
  if (!startsAt) return { ok: false, error: 'invalid' };
  if (startsAt.getTime() <= now.getTime()) return { ok: false, error: 'past' };
  const durationMin = parsed.durationMin ?? defaultDurationMin;
  if (durationMin < DURATION_MIN || durationMin > DURATION_MAX) return { ok: false, error: 'duration' };
  return { ok: true, slot: { startsAt, durationMin } };
}

/** « Mar. 21/10 · 18h00-19h30 » (fuseau du serveur). */
export function slotLabel(slot: SlotInput, zone: string, locale: string): string {
  const start = DateTime.fromJSDate(slot.startsAt, { zone }).setLocale(locale);
  const end = start.plus({ minutes: slot.durationMin });
  const day = start.toFormat('ccc dd/MM');
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${start.toFormat("HH'h'mm")}-${end.toFormat("HH'h'mm")}`;
}

export interface SlotTally {
  slotId: number;
  startsAt: Date;
  durationMin: number;
  yes: string[];
  maybe: string[];
  no: string[];
}

/** Réponses regroupées par créneau, dans l'ordre chronologique. */
export function tallySlots(
  slots: ReadonlyArray<{ id: number; startsAt: Date; durationMin: number }>,
  votes: ReadonlyArray<{ slotId: number; userId: string; answer: Availability }>,
): SlotTally[] {
  return [...slots]
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .map((s) => {
      const of = (answer: Availability) => votes.filter((v) => v.slotId === s.id && v.answer === answer).map((v) => v.userId);
      return { slotId: s.id, startsAt: s.startsAt, durationMin: s.durationMin, yes: of('yes'), maybe: of('maybe'), no: of('no') };
    });
}

/** Classement : le plus de disponibles, puis le plus de « si nécessaire », puis le plus tôt. */
export function rankSlots(tally: readonly SlotTally[]): SlotTally[] {
  return [...tally].sort((a, b) => b.yes.length - a.yes.length || b.maybe.length - a.maybe.length || a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Créneau gagnant sans ambiguïté : en tête du classement et strictement devant le deuxième
 * (disponibles, puis « si nécessaire »). Null si personne n'a répondu ou en cas d'égalité :
 * l'organisateur tranche.
 */
export function bestSlot(tally: readonly SlotTally[]): SlotTally | null {
  const [first, second] = rankSlots(tally);
  if (!first || first.yes.length + first.maybe.length === 0) return null;
  if (second && second.yes.length === first.yes.length && second.maybe.length === first.maybe.length) return null;
  return first;
}

/** Participants qui ont répondu à au moins un créneau. */
export function respondents(tally: readonly SlotTally[]): Set<string> {
  return new Set(tally.flatMap((t) => [...t.yes, ...t.maybe, ...t.no]));
}

/** Échéances proposées pour la fin des réponses (en heures), la veille du premier créneau en dernier recours. */
export const DEADLINE_CHOICES_H = [24, 48, 72, 120, 168] as const;

/** Fin des réponses : au plus tard 2 h avant le premier créneau, pour laisser le temps de fixer la date. */
export function pollDeadline(choiceH: number | 'eve', now: Date, firstSlot: Date): Date {
  const latest = firstSlot.getTime() - 2 * 3_600_000;
  const eve = firstSlot.getTime() - 24 * 3_600_000;
  const wanted = choiceH === 'eve' ? eve : now.getTime() + choiceH * 3_600_000;
  return new Date(Math.max(now.getTime() + 3_600_000, Math.min(wanted, latest)));
}
