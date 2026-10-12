import { describe, expect, it } from 'vitest';
import { formatOffset, isNudgeReminder, isReminderStale, parseOffsets, planJobs } from '../src/domain/reminders.js';

const startsAt = new Date('2026-10-15T16:00:00Z');
const meeting = { startsAt, durationMin: 60, status: 'scheduled' as const };
const at = (iso: string) => new Date(iso);

describe('planJobs', () => {
  it('rappels + début (pas de clôture à heure fixe)', () => {
    const jobs = planJobs(meeting, [15, 1440], at('2026-10-12T10:00:00Z'));
    expect(jobs.map((j) => [j.kind, j.offsetMin, j.dueAt.toISOString()])).toEqual([
      ['reminder', 1440, '2026-10-14T16:00:00.000Z'],
      ['reminder', 15, '2026-10-15T15:45:00.000Z'],
      ['start', 0, '2026-10-15T16:00:00.000Z'],
    ]);
  });

  it('ignore les rappels déjà passés', () => {
    const jobs = planJobs(meeting, [1440, 15], at('2026-10-15T10:00:00Z'));
    expect(jobs.filter((j) => j.kind === 'reminder').map((j) => j.offsetMin)).toEqual([15]);
  });

  it('dédoublonne et ignore les délais non positifs', () => {
    const jobs = planJobs(meeting, [15, 15, 0, -5], at('2026-10-12T10:00:00Z'));
    expect(jobs.filter((j) => j.kind === 'reminder').map((j) => j.offsetMin)).toEqual([15]);
  });

  it('début immédiat si la date est (presque) passée', () => {
    const now = at('2026-10-15T16:00:30Z');
    expect(planJobs(meeting, [], now).find((j) => j.kind === 'start')?.dueAt).toEqual(now);
  });

  it('réunion en cours : plus rien de planifié (clôture sur vocal vide)', () => {
    expect(planJobs({ ...meeting, status: 'live' }, [15], at('2026-10-15T16:10:00Z'))).toEqual([]);
  });

  it('réunion close ou annulée : rien', () => {
    expect(planJobs({ ...meeting, status: 'ended' }, [15], at('2026-10-12T10:00:00Z'))).toEqual([]);
    expect(planJobs({ ...meeting, status: 'cancelled' }, [15], at('2026-10-12T10:00:00Z'))).toEqual([]);
  });
});

describe('rappels', () => {
  it('rappel périmé après le début', () => {
    expect(isReminderStale(startsAt, at('2026-10-15T15:59:59Z'))).toBe(false);
    expect(isReminderStale(startsAt, startsAt)).toBe(true);
  });

  it('la relance accompagne le premier rappel', () => {
    expect(isNudgeReminder(1440, [1440, 15])).toBe(true);
    expect(isNudgeReminder(15, [1440, 15])).toBe(false);
    expect(isNudgeReminder(15, [])).toBe(false);
  });
});

describe('parseOffsets', () => {
  it.each([
    ['1440, 15', [1440, 15]],
    ['1j, 15min', [1440, 15]],
    ['15 2h 1d', [1440, 120, 15]],
    ['30;30', [30]],
    ['1j, 15 min', [1440, 15]],
    ['1 jour et 15 minutes', [1440, 15]],
    ['24h, 15mn', [1440, 15]],
    ['2 heures + 30min', [120, 30]],
    ['1h30', [90]],
    ['1h 30', [60, 30]],
    ['1J,15MIN', [1440, 15]],
  ])('%s', (input, expected) => {
    expect(parseOffsets(input)).toEqual(expected);
  });

  it.each(['', 'abc', '0', '15j', '1,2,3,4,5,6', '-5', '15 semaines', '15 min puis 2h', '1.5h'])('rejette « %s »', (input) => {
    expect(parseOffsets(input)).toBeNull();
  });

  it('formatOffset', () => {
    expect([1440, 120, 15, 90].map(formatOffset)).toEqual(['1 j', '2 h', '15 min', '90 min']);
  });
});
