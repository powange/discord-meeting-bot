import { describe, expect, it } from 'vitest';
import { captureWarning, lossRatio } from '../src/domain/capture.js';

describe('qualité de capture', () => {
  it('taux de perte', () => {
    expect(lossRatio({ receivedPackets: 1000, writtenPackets: 880, streamErrors: 0 })).toBeCloseTo(0.12);
    expect(lossRatio({ receivedPackets: 0, writtenPackets: 0, streamErrors: 0 })).toBe(0);
  });
  it.each([
    [{ receivedPackets: 1000, writtenPackets: 1000, streamErrors: 0 }, null],
    [{ receivedPackets: 1000, writtenPackets: 970, streamErrors: 0 }, null], // 3 % : acceptable
    [{ receivedPackets: 1000, writtenPackets: 880, streamErrors: 0 }, 12],
    [{ receivedPackets: 1000, writtenPackets: 980, streamErrors: 2 }, 2], // flux interrompus + pertes
    [{ receivedPackets: 100, writtenPackets: 10, streamErrors: 3 }, null], // trop peu pour juger
  ])('%o → %s', (counts, expected) => {
    expect(captureWarning(counts)).toBe(expected);
  });
});
