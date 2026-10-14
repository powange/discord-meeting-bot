import { describe, expect, it } from 'vitest';
import { formatOffset, isReminderStale, parseOffsets, planJobs, planPollJobs } from '../src/domain/reminders.js';

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

  it('salon créé automatiquement : création planifiée N min avant le début, tant qu’il n’existe pas', () => {
    const now = at('2026-10-12T10:00:00Z');
    const pending = planJobs({ ...meeting, voiceChannelId: null }, [], now, 2, 30);
    expect(pending.find((j) => j.kind === 'voice_create')?.dueAt.toISOString()).toBe('2026-10-15T15:30:00.000Z');
    expect(planJobs({ ...meeting, voiceChannelId: '42' }, [], now, 2, 30).some((j) => j.kind === 'voice_create')).toBe(false);
    // Réunion créée moins de N min avant : salon créé tout de suite.
    const late = at('2026-10-15T15:50:00Z');
    expect(planJobs({ ...meeting, voiceChannelId: null }, [], late, 2, 30).find((j) => j.kind === 'voice_create')?.dueAt).toEqual(late);
  });

  it('réunion en cours : plus rien de planifié (clôture sur vocal vide)', () => {
    expect(planJobs({ ...meeting, status: 'live' }, [15], at('2026-10-15T16:10:00Z'))).toEqual([]);
  });

  it('réunion close ou annulée : rien', () => {
    expect(planJobs({ ...meeting, status: 'ended' }, [15], at('2026-10-12T10:00:00Z'))).toEqual([]);
    expect(planJobs({ ...meeting, status: 'cancelled' }, [15], at('2026-10-12T10:00:00Z'))).toEqual([]);
  });
});

describe('rappels et changement d’heure', () => {
  it('rappel J-1 à la même heure de la veille, même à travers le passage à l’heure d’hiver', () => {
    // Dimanche 25/10/2026 18h à Paris (heure d'hiver, UTC+1) ; la veille, samedi 18h, est à l'heure d'été (UTC+2).
    const meeting = { startsAt: new Date('2026-10-25T17:00:00Z'), durationMin: 60, status: 'scheduled' as const };
    const now = new Date('2026-10-20T10:00:00Z');
    const withZone = planJobs(meeting, [1440], now, 0, 15, 'Europe/Paris').find((j) => j.kind === 'reminder')!;
    expect(withZone.dueAt.toISOString()).toBe('2026-10-24T16:00:00.000Z'); // samedi 18h heure de Paris
    const raw = planJobs(meeting, [1440], now).find((j) => j.kind === 'reminder')!;
    expect(raw.dueAt.toISOString()).toBe('2026-10-24T17:00:00.000Z'); // 24 h avant : 19h
  });
});

describe('sondage non tranché', () => {
  const slots = [new Date('2026-10-20T16:00:00Z'), new Date('2026-10-22T16:00:00Z')];
  it('réponses closes : relance de l’organisateur la veille du premier créneau, annulation après le dernier', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    expect(planPollJobs(new Date('2026-10-16T10:00:00Z'), now, slots).map((j) => [j.kind, j.dueAt.toISOString()])).toEqual([
      ['poll_remind', '2026-10-19T16:00:00.000Z'],
      ['poll_expire', '2026-10-22T16:00:00.000Z'],
    ]);
  });
  it('réponses encore ouvertes : relance des non-répondants et clôture, comme avant', () => {
    expect(planPollJobs(new Date('2026-10-18T10:00:00Z'), new Date('2026-10-16T09:00:00Z'), slots).map((j) => j.kind)).toEqual(['poll_nudge', 'poll_close']);
  });
  it('tous les créneaux passés : annulation tout de suite', () => {
    const now = new Date('2026-10-23T12:00:00Z');
    expect(planPollJobs(new Date('2026-10-16T10:00:00Z'), now, slots)).toEqual([{ kind: 'poll_expire', offsetMin: 0, dueAt: now }]);
  });
});

describe('rappels', () => {
  it('rappel périmé après le début', () => {
    expect(isReminderStale(startsAt, at('2026-10-15T15:59:59Z'))).toBe(false);
    expect(isReminderStale(startsAt, startsAt)).toBe(true);
  });

  it('la relance accompagne le premier rappel', () => {
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
