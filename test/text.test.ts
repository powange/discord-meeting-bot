import { describe, expect, it } from 'vitest';
import { chunkJoin, joinLinesWithin, truncate } from '../src/lib/text.js';

describe('truncate', () => {
  it('ne touche pas un texte court, ajoute une ellipse sinon', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
});

describe('joinLinesWithin', () => {
  const more = (n: number) => `+${n}`;
  it('tout tient', () => {
    expect(joinLinesWithin(['a', 'b'], 10, more)).toBe('a\nb');
  });
  it('remplace la fin par un compteur, sans dépasser la limite', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `ligne ${i}`);
    const out = joinLinesWithin(lines, 100, more);
    expect(out.length).toBeLessThanOrEqual(100);
    const shown = out.split('\n').length - 1;
    expect(out.endsWith(`+${50 - shown}`)).toBe(true);
  });
  it('ligne unique trop longue', () => {
    expect(joinLinesWithin(['x'.repeat(50)], 10, more).length).toBeLessThanOrEqual(10);
  });
});

describe('chunkJoin', () => {
  it('le préfixe ne figure que dans le premier message', () => {
    const parts = Array.from({ length: 10 }, (_, i) => `<@${'1'.repeat(18)}${i}>`);
    const out = chunkJoin('Rappel : ', parts, 60);
    expect(out[0]!.startsWith('Rappel : ')).toBe(true);
    expect(out.slice(1).every((m) => !m.includes('Rappel'))).toBe(true);
    expect(out.every((m) => m.length <= 60)).toBe(true);
    expect(out.join(' ').match(/<@/g)).toHaveLength(10);
  });
  it('sans fragment, renvoie le préfixe', () => {
    expect(chunkJoin('Seul', [], 100)).toEqual(['Seul']);
  });
});
