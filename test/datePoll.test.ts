import { describe, expect, it } from 'vitest';
import { bestSlot, parseSlots, pollDeadline, rankSlots, respondents, slotLabel, tallySlots } from '../src/domain/datePoll.js';

const zone = 'Europe/Paris';
const now = new Date('2026-10-13T10:00:00Z'); // mardi 13/10, midi à Paris

describe('créneaux saisis', () => {
  it('formats de « Autre date », jour de la semaine facultatif, triés par date', () => {
    const r = parseSlots('jeu 22/10 18h30\nmar 20/10 18h-19h30\n15 janv. 9h', zone, now, 60);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slots.map((s) => [s.startsAt.toISOString(), s.durationMin])).toEqual([
      ['2026-10-20T16:00:00.000Z', 90],
      ['2026-10-22T16:30:00.000Z', 60],
      ['2027-01-15T08:00:00.000Z', 60],
    ]);
  });

  it.each([
    ['20/10 18h', 'count', undefined],
    ['20/10 18h\nn’importe quoi', 'format', 2],
    ['20/10 18h\n31/02 18h', 'invalid', 2],
    ['20/10 18h\n12/10/2026 18h', 'past', 2],
    ['20/10 18h\nmar 20/10 18h', 'duplicate', 2],
  ])('%j → %s', (input, error, line) => {
    expect(parseSlots(input, zone, now, 60)).toEqual({ ok: false, error, ...(line ? { line } : {}) });
  });

  it('plus de 10 créneaux refusés', () => {
    const lines = Array.from({ length: 11 }, (_, i) => `${20 + (i % 9)}/10 ${8 + i}h`).join('\n');
    expect(parseSlots(lines, zone, now, 60)).toMatchObject({ ok: false, error: 'count' });
  });

  it('libellé lisible dans le fuseau du serveur', () => {
    expect(slotLabel({ startsAt: new Date('2026-10-20T16:00:00Z'), durationMin: 90 }, zone, 'fr')).toBe('Mar. 20/10 · 18h00-19h30');
  });
});

describe('réponses et classement', () => {
  const slots = [
    { id: 1, startsAt: new Date('2026-10-20T16:00:00Z'), durationMin: 60 },
    { id: 2, startsAt: new Date('2026-10-22T16:00:00Z'), durationMin: 60 },
    { id: 3, startsAt: new Date('2026-10-23T16:00:00Z'), durationMin: 60 },
  ];
  const vote = (slotId: number, userId: string, answer: 'yes' | 'maybe' | 'no') => ({ slotId, userId, answer });

  it('meilleur créneau : le plus de disponibles, puis de « si nécessaire »', () => {
    const tally = tallySlots(slots, [vote(1, 'a', 'yes'), vote(2, 'a', 'yes'), vote(2, 'b', 'maybe'), vote(3, 'b', 'no')]);
    expect(rankSlots(tally).map((t) => t.slotId)).toEqual([2, 1, 3]);
    expect(bestSlot(tally)?.slotId).toBe(2);
    expect([...respondents(tally)].sort()).toEqual(['a', 'b']);
  });

  it('égalité ou aucune réponse : pas de gagnant (l’organisateur tranche)', () => {
    expect(bestSlot(tallySlots(slots, [vote(1, 'a', 'yes'), vote(2, 'b', 'yes')]))).toBeNull();
    expect(bestSlot(tallySlots(slots, []))).toBeNull();
    expect(bestSlot(tallySlots(slots, [vote(1, 'a', 'no')]))).toBeNull();
  });
});

describe('fin des réponses', () => {
  const first = new Date('2026-10-20T16:00:00Z');
  it('dans N heures, jamais après 2 h avant le premier créneau ; « la veille » = 24 h avant', () => {
    expect(pollDeadline(72, now, first).toISOString()).toBe('2026-10-16T10:00:00.000Z');
    // 7 jours dépasserait le premier créneau du 18/10 : plafonné à 2 h avant.
    expect(pollDeadline(168, now, new Date('2026-10-18T16:00:00Z')).toISOString()).toBe('2026-10-18T14:00:00.000Z');
    expect(pollDeadline('eve', now, first).toISOString()).toBe('2026-10-19T16:00:00.000Z');
  });
  it('premier créneau très proche : au moins une heure pour répondre', () => {
    expect(pollDeadline(24, now, new Date(now.getTime() + 90 * 60_000)).getTime()).toBe(now.getTime() + 3_600_000);
  });
});
