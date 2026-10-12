import { DateTime } from 'luxon';

export type ParseResult = { ok: true; value: DateTime } | { ok: false; error: 'format' | 'invalid' };

const DATE_PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray, now: DateTime) => { y: number; mo: number; d: number; yearGiven: boolean } }> = [
  // 15/10/2026, 15-10-2026, 15.10.26
  { re: /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/, build: (m, _n) => ({ d: +m[1]!, mo: +m[2]!, y: normYear(+m[3]!), yearGiven: true }) },
  // 2026-10-15
  { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, build: (m) => ({ y: +m[1]!, mo: +m[2]!, d: +m[3]!, yearGiven: true }) },
  // 15/10 (année déduite)
  { re: /^(\d{1,2})[/.-](\d{1,2})$/, build: (m, n) => ({ d: +m[1]!, mo: +m[2]!, y: n.year, yearGiven: false }) },
];

// 18:30, 18h30, 18h, 18H, 18
const TIME_RE = /^(\d{1,2})(?:\s*[:hH]\s*(\d{2})?)?$/;

function normYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

/**
 * Analyse une saisie libre « date heure » (ex. `15/10/2026 18:30`, `15/10 18h`, `2026-10-15 9h15`)
 * dans le fuseau `zone`. Sans année, on prend la prochaine occurrence à partir de `now`.
 */
export function parseDateTime(input: string, zone: string, now: DateTime): ParseResult {
  const parts = input.trim().replace(/\s+(à|a)\s+/i, ' ').split(/\s+/);
  if (parts.length !== 2) return { ok: false, error: 'format' };
  const [datePart, timePart] = parts as [string, string];

  const timeMatch = TIME_RE.exec(timePart);
  if (!timeMatch) return { ok: false, error: 'format' };
  const hour = +timeMatch[1]!;
  const minute = timeMatch[2] ? +timeMatch[2] : 0;

  const nowInZone = now.setZone(zone);
  for (const { re, build } of DATE_PATTERNS) {
    const m = re.exec(datePart);
    if (!m) continue;
    const { y, mo, d, yearGiven } = build(m, nowInZone);
    let dt = DateTime.fromObject({ year: y, month: mo, day: d, hour, minute }, { zone });
    if (!dt.isValid || dt.hour !== hour || dt.minute !== minute) return { ok: false, error: 'invalid' };
    if (!yearGiven && dt < nowInZone.minus({ days: 1 })) dt = dt.plus({ years: 1 });
    if (!dt.isValid) return { ok: false, error: 'invalid' };
    return { ok: true, value: dt };
  }
  return { ok: false, error: 'format' };
}

const CLOCK = String.raw`(\d{1,2})(?:\s*[:hH]\s*(\d{2})?)?`;
const RANGE_RE = new RegExp(String.raw`^${CLOCK}(?:\s*(?:-|–|à|a)\s*${CLOCK})?$`, 'i');

export type TimeRangeResult = { ok: true; hour: number; minute: number; durationMin: number | null } | { ok: false };

/**
 * Analyse un horaire : « 18h », « 18:30 », « 18h-19h30 », « 18h à 19h ».
 * Avec une heure de fin, renvoie la durée (une fin avant le début passe au lendemain).
 */
export function parseTimeRange(input: string): TimeRangeResult {
  const m = RANGE_RE.exec(input.trim());
  if (!m) return { ok: false };
  const clock = (h?: string, min?: string) => ({ h: Number(h), min: min ? Number(min) : 0 });
  const start = clock(m[1], m[2]);
  if (start.h > 23 || start.min > 59) return { ok: false };
  if (m[3] === undefined) return { ok: true, hour: start.h, minute: start.min, durationMin: null };
  const end = clock(m[3], m[4]);
  if (end.h > 24 || end.min > 59 || (end.h === 24 && end.min > 0)) return { ok: false };
  let duration = end.h * 60 + end.min - (start.h * 60 + start.min);
  if (duration <= 0) duration += 24 * 60;
  return { ok: true, hour: start.h, minute: start.min, durationMin: duration };
}

/** « 18h00-19h30 » : horaire canonique, pour pré-remplir le formulaire. */
export function formatTimeRange(startsAt: Date, durationMin: number, zone: string): string {
  const start = DateTime.fromJSDate(startsAt, { zone });
  const end = start.plus({ minutes: durationMin });
  return `${start.toFormat("HH'h'mm")}-${end.toFormat("HH'h'mm")}`;
}

/** Date ISO (« 2026-10-15 ») + heure dans le fuseau ; `null` si l'heure n'existe pas (passage à l'heure d'été). */
export function combineDayTime(day: string, hour: number, minute: number, zone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const dt = DateTime.fromISO(day, { zone }).set({ hour, minute, second: 0, millisecond: 0 });
  if (!dt.isValid || dt.hour !== hour || dt.minute !== minute) return null;
  return dt.toJSDate();
}

/** Jour (ISO) d'une date dans le fuseau. */
export function dayOf(date: Date, zone: string): string {
  return DateTime.fromJSDate(date, { zone }).toISODate()!;
}

/**
 * Jours proposés dans le formulaire : `count` jours à partir d'aujourd'hui. Un jour imposé
 * (date actuelle de la réunion, ou date passée en option) est inclus et mis en tête s'il est hors fenêtre.
 */
export function dayChoices(zone: string, now: Date, count: number, include?: string): string[] {
  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  const days = Array.from({ length: count }, (_, i) => today.plus({ days: i }).toISODate()!);
  if (include && !days.includes(include)) return [include, ...days.slice(0, count - 1)];
  return days;
}

/** Timestamp Discord (`<t:…:F>`), affiché dans le fuseau de chaque lecteur. */
export function discordTimestamp(date: Date, style: 'F' | 'f' | 'R' | 't' | 'D' | 'd' = 'F'): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

/** Date lisible dans le fuseau du serveur (format fourni par la langue), ex. « lundi 12/10 à 18h00 ». */
export function formatWhen(date: Date, zone: string, locale: string, format: string): string {
  return DateTime.fromJSDate(date, { zone }).setLocale(locale).toFormat(format);
}
