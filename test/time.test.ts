import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { combineDayTime, dayChoices, formatTimeRange, parseDatedRange, parseDateTime, parseTimeRange } from '../src/domain/time.js';

const zone = 'Europe/Paris';
const now = DateTime.fromISO('2026-10-12T10:00:00', { zone });

function parse(input: string) {
  const r = parseDateTime(input, zone, now);
  return r.ok ? r.value.toISO() : r.error;
}

describe('parseDateTime', () => {
  it.each([
    ['15/10/2026 18:30', '2026-10-15T18:30:00.000+02:00'],
    ['15/10/26 18h30', '2026-10-15T18:30:00.000+02:00'],
    ['15.10.2026 18h', '2026-10-15T18:00:00.000+02:00'],
    ['2026-10-15 9:05', '2026-10-15T09:05:00.000+02:00'],
    ['15/10 à 18h', '2026-10-15T18:00:00.000+02:00'],
    ['  15/10   18  ', '2026-10-15T18:00:00.000+02:00'],
  ])('%s', (input, expected) => {
    expect(parse(input)).toBe(expected);
  });

  it("gère le changement d'heure (heure d'hiver après le 25/10)", () => {
    expect(parse('02/11/2026 18:00')).toBe('2026-11-02T18:00:00.000+01:00');
  });

  it("sans année, prend l'année suivante si la date est passée", () => {
    expect(parse('05/01 10:00')).toBe('2027-01-05T10:00:00.000+01:00');
    expect(parse('12/10 08:00')).toBe('2026-10-12T08:00:00.000+02:00'); // aujourd'hui : on garde
  });

  it('rejette les formats illisibles', () => {
    expect(parse('demain 18h')).toBe('format');
    expect(parse('15/10/2026')).toBe('format');
    expect(parse('15/10/2026 18:3')).toBe('format');
  });

  it('rejette les dates impossibles', () => {
    expect(parse('31/02/2026 10:00')).toBe('invalid');
    expect(parse('15/10/2026 25:00')).toBe('invalid');
    expect(parse('15/10/2026 10:75')).toBe('invalid');
  });

  it("rejette une heure qui n'existe pas (passage à l'heure d'été)", () => {
    expect(parse('29/03/2026 02:30')).toBe('invalid');
  });
});

describe('parseTimeRange', () => {
  it.each([
    ['18h', [18, 0, null]],
    ['18:30', [18, 30, null]],
    ['9H05', [9, 5, null]],
    ['18h-19h30', [18, 0, 90]],
    ['18h00 - 19h00', [18, 0, 60]],
    ['18h à 20h', [18, 0, 120]],
    ['18:30–19:15', [18, 30, 45]],
    ['23h-1h', [23, 0, 120]], // passe minuit
    ['22h-24h', [22, 0, 120]],
  ])('%s', (input, [hour, minute, durationMin]) => {
    expect(parseTimeRange(input)).toEqual({ ok: true, hour, minute, durationMin });
  });

  it.each(['', 'midi', '25h', '18h75', '18h-', '18h-25h', '18h-24h30', '18h30h'])('rejette « %s »', (input) => {
    expect(parseTimeRange(input).ok).toBe(false);
  });

  it('formatTimeRange est relisible', () => {
    const start = new Date('2026-10-12T16:00:00Z');
    const text = formatTimeRange(start, 90, zone);
    expect(text).toBe('18h00-19h30');
    expect(parseTimeRange(text)).toEqual({ ok: true, hour: 18, minute: 0, durationMin: 90 });
  });
});

describe('combineDayTime', () => {
  it('jour + heure dans le fuseau', () => {
    expect(combineDayTime('2026-10-15', 18, 30, zone)?.toISOString()).toBe('2026-10-15T16:30:00.000Z');
    expect(combineDayTime('2026-11-02', 18, 0, zone)?.toISOString()).toBe('2026-11-02T17:00:00.000Z');
  });
  it("refuse une heure inexistante et un jour mal formé", () => {
    expect(combineDayTime('2026-03-29', 2, 30, zone)).toBeNull();
    expect(combineDayTime('15/10/2026', 18, 0, zone)).toBeNull();
  });
});

describe('dayChoices', () => {
  const nowDate = now.toJSDate();
  it("25 jours à partir d'aujourd'hui (dans le fuseau)", () => {
    const days = dayChoices(zone, nowDate, 25);
    expect(days).toHaveLength(25);
    expect(days[0]).toBe('2026-10-12');
    expect(days[24]).toBe('2026-11-05');
  });
  it('un jour imposé hors fenêtre est mis en tête', () => {
    const days = dayChoices(zone, nowDate, 25, '2027-01-15');
    expect(days).toHaveLength(25);
    expect(days[0]).toBe('2027-01-15');
    expect(days[1]).toBe('2026-10-12');
  });
  it('un jour imposé dans la fenêtre ne change rien', () => {
    expect(dayChoices(zone, nowDate, 25, '2026-10-20')).toEqual(dayChoices(zone, nowDate, 25));
  });
  it('minuit à Paris = encore la veille en UTC', () => {
    expect(dayChoices(zone, new Date('2026-10-12T22:30:00Z'), 1)).toEqual(['2026-10-13']);
  });
});

describe('parseDatedRange (option « Autre date »)', () => {
  it.each([
    ['15/01/2027 18h-19h30', { day: '2027-01-15', hour: 18, minute: 0, durationMin: 90 }],
    ['15/01 18:30', { day: '2027-01-15', hour: 18, minute: 30, durationMin: null }], // année déduite
    ['2027-03-02 à 9h', { day: '2027-03-02', hour: 9, minute: 0, durationMin: null }],
    // Noms de mois en toutes lettres ou abrégés.
    ['15 janv. 18h-19h30', { day: '2027-01-15', hour: 18, minute: 0, durationMin: 90 }],
    ['3 mars 2027 18h', { day: '2027-03-03', hour: 18, minute: 0, durationMin: null }],
    ['1er décembre à 20h', { day: '2026-12-01', hour: 20, minute: 0, durationMin: null }],
  ])('%s', (input, expected) => {
    expect(parseDatedRange(input, zone, now)).toEqual({ ok: true, ...expected });
  });
  it('erreurs', () => {
    expect(parseDatedRange('18h-19h', zone, now)).toEqual({ ok: false, error: 'format' });
    expect(parseDatedRange('31/02/2027 18h', zone, now)).toEqual({ ok: false, error: 'invalid' });
  });
});
