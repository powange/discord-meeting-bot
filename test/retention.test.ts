import { describe, expect, it } from 'vitest';
import { mixesToPurge, rawTracksToPurge, unprocessedTracksExpiringSoon, type RawCandidate } from '../src/domain/retention.js';

const now = new Date('2026-12-01T00:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const raw = (over: Partial<RawCandidate>): RawCandidate => ({
  recordingId: 'r',
  meetingStatus: 'ended',
  endedAt: daysAgo(40),
  purgedAt: null,
  mix: 'done',
  transcribe: 'done',
  hasSegments: true,
  days: 30,
  ...over,
});

describe('rawTracksToPurge', () => {
  it('réunion close, traitée, ancienne : purgée', () => {
    expect(rawTracksToPurge([raw({})], now)).toEqual(['r']);
  });
  it.each<[string, Partial<RawCandidate>]>([
    ['trop récente', { endedAt: daysAgo(10) }],
    ['réunion encore ouverte', { meetingStatus: 'live' }],
    ['traitement en échec (pas encore le double du délai)', { transcribe: 'failed' }],
    ['traitement jamais lancé (pas encore le double du délai)', { mix: null, transcribe: null }],
    ['déjà purgée', { purgedAt: daysAgo(1) }],
    ['session en cours', { endedAt: null }],
    ['rétention désactivée (0)', { days: 0 }],
  ])('conservée : %s', (_label, over) => {
    expect(rawTracksToPurge([raw(over)], now)).toEqual([]);
  });
  it('session sans parole : purgée même sans traitement', () => {
    expect(rawTracksToPurge([raw({ hasSegments: false, mix: null, transcribe: null })], now)).toEqual(['r']);
  });
  it('traitement en échec : gardé deux fois plus longtemps, puis purgé (jamais à vie), avec un avis la veille', () => {
    const failed = (age: number) => raw({ transcribe: 'failed', endedAt: daysAgo(age) });
    expect(rawTracksToPurge([failed(59)], now)).toEqual([]);
    expect(unprocessedTracksExpiringSoon([failed(59.5)], now)).toEqual(['r']);
    expect(unprocessedTracksExpiringSoon([failed(40)], now)).toEqual([]);
    expect(rawTracksToPurge([failed(60)], now)).toEqual(['r']);
    expect(unprocessedTracksExpiringSoon([raw({ endedAt: daysAgo(59.5) })], now)).toEqual([]); // traité : rien à signaler
  });
});

describe('mixesToPurge', () => {
  it('seulement les audios assez anciens, non purgés, rétention active', () => {
    const c = (meetingId: string, age: number, extra = {}) => ({ meetingId, file: `/d/${meetingId}.ogg`, finishedAt: daysAgo(age), purged: false, days: 365, ...extra });
    const out = mixesToPurge([c('vieux', 400), c('recent', 10), c('purge', 400, { purged: true }), c('garde', 400, { days: 0 }), c('sans', 400, { file: null })], now);
    expect(out.map((x) => x.meetingId)).toEqual(['vieux']);
  });
});
