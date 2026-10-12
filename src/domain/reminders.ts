import type { JobKind, MeetingStatus } from './types.js';

/** Délai après la fin prévue au-delà duquel une réunion « en cours » est close automatiquement. */
export const AUTO_END_GRACE_MIN = 120;

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
  meeting: { startsAt: Date; durationMin: number; status: MeetingStatus },
  reminderOffsetsMin: readonly number[],
  now: Date,
): PlannedJob[] {
  const jobs: PlannedJob[] = [];
  const start = meeting.startsAt.getTime();
  const autoEnd: PlannedJob = {
    kind: 'auto_end',
    offsetMin: 0,
    dueAt: new Date(start + (meeting.durationMin + AUTO_END_GRACE_MIN) * 60_000),
  };

  if (meeting.status === 'live') return [autoEnd];
  if (meeting.status !== 'scheduled') return [];

  for (const offset of [...new Set(reminderOffsetsMin)].filter((o) => o > 0).sort((a, b) => b - a)) {
    const dueAt = new Date(start - offset * 60_000);
    if (dueAt.getTime() > now.getTime()) jobs.push({ kind: 'reminder', offsetMin: offset, dueAt });
  }
  jobs.push({ kind: 'start', offsetMin: 0, dueAt: new Date(Math.max(start, now.getTime())) });
  jobs.push(autoEnd);
  return jobs;
}

/** Un rappel arrivé après le début (bot éteint pendant l'échéance) n'est plus envoyé. */
export function isReminderStale(startsAt: Date, now: Date): boolean {
  return now.getTime() >= startsAt.getTime();
}

/** La relance des non-répondants accompagne le rappel le plus précoce. */
export function isNudgeReminder(offsetMin: number, reminderOffsetsMin: readonly number[]): boolean {
  return reminderOffsetsMin.length > 0 && offsetMin === Math.max(...reminderOffsetsMin);
}

/** Analyse « 1440, 15 », « 1j, 15min », « 2h » → minutes. */
export function parseOffsets(input: string): number[] | null {
  const parts = input.split(/[,;\s]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 5) return null;
  const out: number[] = [];
  for (const p of parts) {
    const m = /^(\d+)\s*(j|d|h|m|min)?$/i.exec(p);
    if (!m) return null;
    const n = +m[1]!;
    const unit = (m[2] ?? 'min').toLowerCase();
    const minutes = unit === 'j' || unit === 'd' ? n * 1440 : unit === 'h' ? n * 60 : n;
    if (minutes <= 0 || minutes > 60 * 24 * 14) return null;
    out.push(minutes);
  }
  return [...new Set(out)].sort((a, b) => b - a);
}

export function formatOffset(min: number): string {
  if (min % 1440 === 0) return `${min / 1440} j`;
  if (min % 60 === 0) return `${min / 60} h`;
  return `${min} min`;
}
