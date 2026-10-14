import { DateTime } from 'luxon';
import type { JobKind, MeetingStatus } from './types.js';

export interface PlannedJob {
  kind: JobKind;
  offsetMin: number;
  dueAt: Date;
}

/**
 * Tâches à programmer pour une réunion. Fonction pure : appelée à la création et à chaque
 * modification (les tâches non exécutées sont alors remplacées).
 * Un rappel dont l'échéance est déjà passée est ignoré (pas de rappel « J-1 » envoyé à H-10 min).
 */
export function planJobs(
  meeting: { startsAt: Date; durationMin: number; status: MeetingStatus; autoRecord?: boolean; voiceChannelId?: string | null },
  reminderOffsetsMin: readonly number[],
  now: Date,
  /** Avance du démarrage auto de l'enregistrement (le bot arrive avant les participants). */
  recordLeadMin = 0,
  /** Avance de la création du salon vocal temporaire (réunion sans salon). */
  voiceLeadMin = 15,
  /** Fuseau du serveur : un rappel en jours tombe à la même heure de la veille, changement d'heure compris. */
  timezone?: string,
): PlannedJob[] {
  // La clôture n'est pas planifiée : elle dépend de la présence dans le vocal (MeetingWatcher).
  const jobs: PlannedJob[] = [];
  const start = meeting.startsAt.getTime();
  if (meeting.status !== 'scheduled') return [];

  for (const offset of [...new Set(reminderOffsetsMin)].filter((o) => o > 0).sort((a, b) => b - a)) {
    const dueAt =
      timezone && offset % 1440 === 0
        ? DateTime.fromJSDate(meeting.startsAt, { zone: timezone }).minus({ days: offset / 1440 }).toJSDate()
        : new Date(start - offset * 60_000);
    if (dueAt.getTime() > now.getTime()) jobs.push({ kind: 'reminder', offsetMin: offset, dueAt });
  }
  if (meeting.voiceChannelId === null) {
    jobs.push({ kind: 'voice_create', offsetMin: voiceLeadMin, dueAt: new Date(Math.max(start - voiceLeadMin * 60_000, now.getTime())) });
  }
  if (meeting.autoRecord) {
    jobs.push({ kind: 'record_start', offsetMin: recordLeadMin, dueAt: new Date(Math.max(start - recordLeadMin * 60_000, now.getTime())) });
  }
  jobs.push({ kind: 'start', offsetMin: 0, dueAt: new Date(Math.max(start, now.getTime())) });
  return jobs.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

/** Un rappel arrivé après le début (bot éteint pendant l'échéance) n'est plus envoyé. */
export function isReminderStale(startsAt: Date, now: Date): boolean {
  return now.getTime() >= startsAt.getTime();
}

const UNIT_MINUTES: Record<string, number> = {
  '': 1, m: 1, mn: 1, min: 1, mins: 1, minute: 1, minutes: 1,
  h: 60, hr: 60, hrs: 60, heure: 60, heures: 60, hour: 60, hours: 60,
  j: 1440, jr: 1440, jrs: 1440, jour: 1440, jours: 1440, d: 1440, day: 1440, days: 1440,
};

/**
 * Analyse une liste de délais → minutes, triées du plus précoce au plus tardif.
 * Accepte « 1440, 15 », « 1j, 15min », « 1 jour et 15 min », « 2h 15mn », « 1h30 ».
 * Un nombre sans unité vaut des minutes, sauf collé à des heures (« 1h30 » = 90 min).
 */
export function parseOffsets(input: string): number[] | null {
  const tokens = [...input.toLowerCase().matchAll(/(\d+)\s*([a-z]*)/g)];
  const unitOf = (t: RegExpExecArray) => (t[2] === 'et' ? '' : (t[2] ?? '')); // « 15 et 2h »
  if (tokens.length === 0) return null;

  // Tout ce qui n'est pas un token doit être un séparateur.
  let cursor = 0;
  const gaps: string[] = [];
  for (const t of tokens) {
    gaps.push(input.slice(cursor, t.index));
    cursor = t.index + t[0].length;
  }
  if (![...gaps, input.slice(cursor)].every((gap) => /^(\s|,|;|\+|et)*$/i.test(gap))) return null;

  const out: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const factor = UNIT_MINUTES[unitOf(token)];
    if (factor === undefined) return null;
    let minutes = Number(token[1]) * factor;
    const next = tokens[i + 1];
    // « 1h30 » : minutes collées (sans séparateur ni unité) à un nombre d'heures.
    if (factor === 60 && next && next[2] === '' && gaps[i + 1] === '') {
      minutes += Number(next[1]);
      i++;
    }
    if (minutes <= 0 || minutes > 60 * 24 * 14) return null;
    out.push(minutes);
  }
  const unique = [...new Set(out)].sort((a, b) => b - a);
  return unique.length <= 5 ? unique : null;
}

export function formatOffset(min: number): string {
  if (min % 1440 === 0) return `${min / 1440} j`;
  if (min % 60 === 0) return `${min / 60} h`;
  return `${min} min`;
}

/**
 * Échéances d'un sondage de date : relance des non-répondants la veille de la fin des
 * réponses (si elle est à plus d'un jour), puis clôture à la fin des réponses. Une fois les
 * réponses closes, si la date n'est toujours pas fixée : l'organisateur est relancé la veille du
 * premier créneau à venir, et le sondage est annulé quand le dernier créneau est passé.
 */
export function planPollJobs(closesAt: Date, now: Date, slotStarts: readonly Date[] = []): PlannedJob[] {
  const jobs: PlannedJob[] = [];
  if (closesAt.getTime() <= now.getTime()) {
    const upcoming = slotStarts.map((d) => d.getTime()).filter((t) => t > now.getTime()).sort((a, b) => a - b);
    const remindAt = (upcoming[0] ?? 0) - 24 * 3_600_000;
    if (remindAt > now.getTime()) jobs.push({ kind: 'poll_remind', offsetMin: 1440, dueAt: new Date(remindAt) });
    jobs.push({ kind: 'poll_expire', offsetMin: 0, dueAt: new Date(Math.max(upcoming.at(-1) ?? 0, now.getTime())) });
    return jobs;
  }
  const nudgeAt = closesAt.getTime() - 24 * 3_600_000;
  if (nudgeAt > now.getTime()) jobs.push({ kind: 'poll_nudge', offsetMin: 1440, dueAt: new Date(nudgeAt) });
  jobs.push({ kind: 'poll_close', offsetMin: 0, dueAt: new Date(Math.max(closesAt.getTime(), now.getTime())) });
  return jobs;
}
