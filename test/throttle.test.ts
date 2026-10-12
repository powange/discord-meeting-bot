import { describe, expect, it } from 'vitest';
import { Throttle } from '../src/domain/throttle.js';

describe('Throttle', () => {
  it('une alerte par cause et par fenêtre', () => {
    const t = new Throttle(60_000);
    expect(t.allow('g:disk', 0)).toBe(true);
    expect(t.allow('g:disk', 30_000)).toBe(false);
    expect(t.allow('g:pipeline', 30_000)).toBe(true); // autre cause
    expect(t.allow('g:disk', 60_000)).toBe(true); // fenêtre écoulée
  });
});
