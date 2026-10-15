import { describe, expect, it } from 'vitest';
import type { ReportInput } from '../src/discord/embeds/report.js';
import { messages } from '../src/i18n/index.js';
import { pdfText, renderReportPdf } from '../src/report/pdf.js';

const m = messages('fr');
const input: ReportInput = {
  title: 'Bureau 🎉',
  subtitle: 'mercredi 14/10 à 21h00 · 26 min 08 s · 4 participants',
  participants: [{ id: '1', name: 'Pierre Comble' }, { id: '2', name: 'Krän' }],
  agenda: [{ id: 1, title: 'Présentation' }, { id: 2, title: 'Feux d’artifice' }],
  summary: {
    overview: 'La réunion a porté sur le bot « Meeting recorder ».',
    topics: [
      { agendaItemId: 2, title: 'Feux d’artifice', summary: 'Pas de certitude.', decisions: ['Tester en jeu'], actions: [{ what: 'Monter un protocole', who: 'Krän', when: 'vendredi' }], openQuestions: ['Dégâts réels ?'] },
      { agendaItemId: null, title: 'Fall Guys', summary: 'Digression.', decisions: [], actions: [], openQuestions: [] },
    ],
  },
  people: new Map(),
  trace: 'Transcription : vibe-geekcom · Résumé : qwen3-14b · 1 passe',
  durations: new Map([[2, 12 * 60_000]]),
};

describe('compte rendu en PDF', () => {
  it('accents, typographie et lettres non latines gardés ; émojis et mentions retirés', () => {
    expect(pdfText('Réunion « été » — œuvre… 🎉 ✅ <@123> fin')).toBe('Réunion « été » — œuvre… fin');
    expect(pdfText('Łukasz, Ondřej et Дмитрий')).toBe('Łukasz, Ondřej et Дмитрий');
  });

  it('police embarquée : les noms non latins sont écrits dans le PDF', async () => {
    const pdf = await renderReportPdf({ ...input, title: 'Réunion avec Łukasz' }, m);
    expect(pdf.toString('latin1')).toContain('DejaVuSans');
  });

  it('un vrai PDF, même avec émojis, sujets hors ODJ, points non traités', async () => {
    const pdf = await renderReportPdf(input, m);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
    const empty = await renderReportPdf({ ...input, summary: { overview: '', topics: [] } }, m);
    expect(empty.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
