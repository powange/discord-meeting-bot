import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { formatDateTimeInput, parseDateTime } from '../src/domain/time.js';

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

  it('formatDateTimeInput est relisible par parseDateTime', () => {
    const date = new Date('2026-12-24T17:45:00Z');
    const text = formatDateTimeInput(date, zone);
    expect(text).toBe('24/12/2026 18:45');
    const back = parseDateTime(text, zone, now);
    expect(back.ok && back.value.toJSDate().getTime()).toBe(date.getTime());
  });
});
