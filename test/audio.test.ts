import { describe, expect, it } from 'vitest';
import { bitrateForLimit, MAX_BITRATE_KBPS, uploadLimitBytes } from '../src/domain/audio.js';

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
