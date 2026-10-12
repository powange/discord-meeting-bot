import { ButtonBuilder, ButtonStyle, ComponentType, type APIContainerComponent } from 'discord.js';
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
  const texts = (c: APIContainerComponent) =>
    c.components.filter((x) => x.type === ComponentType.TextDisplay).map((x) => (x as { content: string }).content);
  const container = renderRecordingSummary(input, { meetingTitle: 'Bureau', interrupted: false }, m);
  const all = texts(container).join('\n');

  it('en-tête : titre, statut, raison, durée précise, participants, prises de parole', () => {
    expect(all).toContain('## ⏹️ Enregistrement · Bureau');
    expect(all).toContain('🟢 Terminé · Arrêt manuel');
    expect(all).toContain('40 min · 3 participants · 3 prises de parole');
  });

  it('participation par personne, non inscrits et opt-out signalés, absents à part', () => {
    expect(all).toContain('**80 %** 🟦🟦🟦🟦⬛ <@a> · 🗣️ 8 min · ⏱️ 40 min (100 %)');
    expect(all).toContain('**20 %** 🟩⬛⬛⬛⬛ <@b> *(non inscrit)*');
    expect(all).toContain('🔇 <@c> · non enregistré');
    expect(all).toContain('### Inscrits absents\n<@d>');
  });

  it('interrompu : couleur orange, message et bouton de reprise', () => {
    const button = new ButtonBuilder().setCustomId('x').setLabel('Reprendre').setStyle(ButtonStyle.Primary);
    const c = renderRecordingSummary(input, { meetingTitle: 'Bureau', interrupted: true, resumeButton: button }, m);
    expect(c.accent_color).toBe(0xe67e22);
    expect(texts(c).join('\n')).toContain('🟠 Interrompu');
    expect(c.components.some((x) => x.type === ComponentType.ActionRow)).toBe(true);
  });

  it('beaucoup de participants : texte total sous 4000 caractères', () => {
    const many = Array.from({ length: 80 }, (_, i) => String(100000000000000000n + BigInt(i)));
    const big = renderRecordingSummary(
      {
        ...input,
        segments: many.map((userId, i) => ({ userId, startMs: i * 1000, endMs: i * 1000 + 500 })),
        presence: many.map((userId) => ({ userId, joinedAt: t('18:00'), leftAt: null, excluded: false })),
        rsvps: many.map((userId) => ({ userId, status: 'yes' as const })),
      },
      { meetingTitle: 'x'.repeat(100), interrupted: false },
      m,
    );
    expect(texts(big).join('').length).toBeLessThanOrEqual(4000);
  });
});

describe('formats', () => {
  it('barre proportionnelle, couleur selon le rang', () => {
    expect(bar(0)).toBe('⬛⬛⬛⬛⬛');
    expect(bar(80)).toBe('🟦🟦🟦🟦⬛');
    expect(bar(100, 1)).toBe('🟩🟩🟩🟩🟩');
    expect(bar(31, 7)).toBe('🟦🟦⬛⬛⬛');
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
