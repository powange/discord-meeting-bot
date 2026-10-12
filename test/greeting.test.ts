import { describe, expect, it } from 'vitest';
import { ArrivalNotices } from '../src/domain/greeting.js';

describe('avertissement des arrivants', () => {
  it('une fois par personne et par session', () => {
    const n = new ArrivalNotices(['present-au-debut']);
    expect(n.shouldNotify('present-au-debut', true)).toBe(false);
    expect(n.shouldNotify('alice', true)).toBe(true);
    expect(n.shouldNotify('alice', true)).toBe(false); // repart et revient
    expect(n.shouldNotify('optout', false)).toBe(false); // pas enregistrée : rien à annoncer
    expect(n.shouldNotify('optout', true)).toBe(true); // a retiré son rôle depuis
  });
});
