import { describe, expect, it } from 'vitest';
import { bitrateForLimit, clock, MAX_BITRATE_KBPS, planParts, uploadLimitBytes } from '../src/domain/audio.js';

const min = (n: number) => n * 60_000;
const MB = 1024 * 1024;

describe('audio complet', () => {
  it('limite par niveau de boost', () => {
    expect([0, 1, 2, 3].map(uploadLimitBytes)).toEqual([10 * MB, 10 * MB, 50 * MB, 100 * MB]);
  });
  it('réunion courte : débit maximal', () => {
    expect(bitrateForLimit(min(30), 10 * MB)).toBe(MAX_BITRATE_KBPS);
  });
  it('réunion longue : débit réduit pour tenir dans la limite', () => {
    const kbps = bitrateForLimit(min(90), 10 * MB)!;
    expect(kbps).toBeLessThan(MAX_BITRATE_KBPS);
    expect((kbps * 1000 * 90 * 60) / 8).toBeLessThanOrEqual(10 * MB);
  });
  it('trop longue même au débit minimal : pas de pièce jointe', () => {
    expect(bitrateForLimit(min(150), 10 * MB)).toBeNull();
    expect(bitrateForLimit(min(150), 50 * MB)).toBe(MAX_BITRATE_KBPS);
  });
});

describe('découpage en parties', () => {
  it('tient en un fichier : une partie au meilleur débit', () => {
    expect(planParts(min(30), 10 * MB)).toEqual({ parts: 1, kbps: MAX_BITRATE_KBPS, partMs: min(30) });
  });
  it('réunion de 2 h 30 sans boost : quelques parties à 24 kbps ou plus, chacune sous la limite', () => {
    const plan = planParts(min(150), 10 * MB)!;
    expect(plan.parts).toBeGreaterThan(1);
    expect(plan.kbps).toBeGreaterThanOrEqual(24);
    expect((plan.kbps * 1000 * plan.partMs) / 1000 / 8).toBeLessThanOrEqual(10 * MB);
    expect(plan.parts * plan.partMs).toBeGreaterThanOrEqual(min(150));
  });
  it('beaucoup trop long : rien', () => {
    expect(planParts(min(60 * 24), 10 * MB)).toBeNull();
  });
  it('repères de temps', () => {
    expect([clock(0), clock(2_480_000), clock(3_930_000)]).toEqual(['0:00', '41:20', '1:05:30']);
  });
});
