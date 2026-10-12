import { describe, expect, it } from 'vitest';
import { bar, participantStats, renderRecordingSummary, type SummaryInput } from '../src/discord/embeds/recordingSummary.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');
const t = (hhmm: string) => new Date(`2026-10-15T${hhmm}:00Z`);
const min = (n: number) => n * 60_000;

const input: SummaryInput = {
  reason: 'arrêt manuel',
  startedAt: t('18:00'),
  endedAt: t('18:40'),
  segments: [
    { userId: 'a', startMs: 0, endMs: min(6) },
    { userId: 'a', startMs: min(10), endMs: min(12) },
    { userId: 'b', startMs: min(7), endMs: min(9) },
  ],
  presence: [
    { userId: 'a', joinedAt: t('18:00'), leftAt: null, excluded: false },
    { userId: 'b', joinedAt: t('18:00'), leftAt: t('18:20'), excluded: false },
    { userId: 'c', joinedAt: t('18:10'), leftAt: null, excluded: true },
  ],
  rsvps: [
    { userId: 'a', status: 'yes' },
    { userId: 'c', status: 'maybe' },
    { userId: 'd', status: 'yes' },
  ],
};

describe('participantStats', () => {
  it('part de parole et de présence par personne, triées par parole', () => {
    const stats = participantStats(input);
    expect(stats.map((s) => [s.userId, s.speechPct, s.presencePct, s.recorded, s.registered])).toEqual([
      ['a', 80, 100, true, true], // 8 min sur 10 de parole, présent tout le long
      ['b', 20, 50, true, false], // non inscrit
      ['c', 0, 75, false, true], // opt-out
    ]);
  });

  it('aucune parole : pas de division par zéro', () => {
    expect(participantStats({ ...input, segments: [] }).every((s) => s.speechPct === 0)).toBe(true);
  });
});

describe('renderRecordingSummary', () => {
  const embed = renderRecordingSummary(input, m);

  it('en-tête : raison, horaires, durée précise, prises de parole', () => {
    expect(embed.description).toContain('Arrêt manuel');
    expect(embed.description).toContain('(40 min)');
    expect(embed.description).toContain('3 prises de parole');
  });

  it('une ligne par participant, inscrits absents à part', () => {
    const [participants, noShow] = embed.fields!;
    expect(participants!.name).toBe('Participants (3)');
    expect(participants!.value).toContain('<@a>');
    expect(participants!.value).toContain('**80 %**');
    expect(participants!.value).toContain('<@b> *(non inscrit)*');
    expect(participants!.value).toContain('🔇 non enregistré');
    expect(noShow).toEqual({ name: 'Inscrits absents (1)', value: '<@d>' });
  });
});

describe('formats', () => {
  it('barre proportionnelle', () => {
    expect(bar(0)).toBe('▱▱▱▱▱▱▱▱▱▱');
    expect(bar(80)).toBe('▰▰▰▰▰▰▰▰▱▱');
    expect(bar(100)).toBe('▰▰▰▰▰▰▰▰▰▰');
  });
  it.each([
    [12_000, '12 s'],
    [60_000, '1 min'],
    [750_000, '12 min 30 s'],
    [3_900_000, '1 h 05'],
  ])('duration(%i) = %s', (ms, expected) => {
    expect(m.format.duration(ms)).toBe(expected);
  });
});
