import { ComponentType, type APIContainerComponent } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { MESSAGE_TEXT_BUDGET, renderReport, renderTranscriptMarkdown, resolvePerson, type ReportInput } from '../src/discord/embeds/report.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');
const people = new Map([
  ['Pierre Comble', '111'],
  ['Marie-Anne', '222'],
  ['Pierre Dupont', '333'],
]);
const texts = (c: APIContainerComponent) =>
  c.components.filter((x) => x.type === ComponentType.TextDisplay).map((x) => (x as { content: string }).content).join('\n');

const base: ReportInput = {
  title: 'Bureau',
  subtitle: 'lundi 12/10 · 42 min · 3 participants',
  agenda: [
    { id: 1, title: 'Budget' },
    { id: 2, title: 'Fête' },
    { id: 3, title: 'Divers' },
  ],
  summary: {
    overview: 'Réunion productive.',
    topics: [
      { agendaItemId: null, title: 'Local', summary: 'Le local fuit.', decisions: [], actions: [], openQuestions: ['Qui appelle le bailleur ?'] },
      {
        agendaItemId: 2,
        title: 'Fête',
        summary: 'Date fixée.',
        decisions: ['Fête le 20/12'],
        actions: [{ what: 'Réserver la salle', who: 'Marie-Anne', when: 'vendredi' }, { what: 'Acheter les boissons', who: 'Paul', when: null }],
        openQuestions: [],
      },
      { agendaItemId: 1, title: 'Budget', summary: 'Budget voté.', decisions: ['Budget 2027 adopté'], actions: [], openQuestions: [] },
    ],
  },
  people,
  trace: 'Transcription : vibe-pc · Résumé : qwen3 · 1 passe',
  transcriptFile: 'transcription.md',
};

describe('resolvePerson', () => {
  it('nom exact (sans accents ni casse), prénom unique, sinon texte', () => {
    expect(resolvePerson('marie-anne', people)).toBe('<@222>');
    expect(resolvePerson('Pierre Comble', people)).toBe('<@111>');
    expect(resolvePerson('Pierre', people)).toBe('Pierre'); // deux Pierre : ambigu
    expect(resolvePerson('Paul', people)).toBe('Paul');
  });
});

describe('renderReport', () => {
  const out = renderReport(base, m);
  const all = out.map(texts).join('\n');

  it('en-tête, synthèse, sujets dans l’ordre de l’ODJ puis hors ODJ', () => {
    expect(all).toContain('## 📝 Compte rendu · Bureau');
    expect(all.indexOf('### 1. Budget')).toBeLessThan(all.indexOf('### 2. Fête'));
    expect(all).toContain('### 3. Local *(hors ordre du jour)*');
  });

  it('décisions, actions avec mention et échéance, questions', () => {
    expect(all).toContain('- ✅ Fête le 20/12');
    expect(all).toContain('- ☐ Réserver la salle — <@222> · 📅 vendredi');
    expect(all).toContain('- ☐ Acheter les boissons — Paul');
    expect(all).toContain('- ❔ Qui appelle le bailleur ?');
  });

  it('points non traités et trace des modèles', () => {
    expect(all).toContain('### Points non traités\n- Divers');
    expect(all).toContain('-# Transcription : vibe-pc');
  });

  it('transcription jointe au dernier message', () => {
    const last = out.at(-1)!;
    expect(last.components.at(-1)).toMatchObject({ type: ComponentType.File, file: { url: 'attachment://transcription.md' } });
  });

  it('compte rendu très long : plusieurs messages, chacun sous la limite', () => {
    const long = renderReport(
      {
        ...base,
        summary: {
          overview: 'x'.repeat(1000),
          topics: Array.from({ length: 12 }, (_, i) => ({
            agendaItemId: null,
            title: `Sujet ${i}`,
            summary: 'blabla '.repeat(150),
            decisions: ['d'.repeat(200)],
            actions: [{ what: 'a'.repeat(150), who: 'Marie-Anne', when: null }],
            openQuestions: [],
          })),
        },
      },
      m,
    );
    expect(long.length).toBeGreaterThan(1);
    for (const c of long) expect(texts(c).length).toBeLessThanOrEqual(4000);
    expect(long.map(texts).join('\n')).toContain('### 12. Sujet 11');
    expect(long.slice(0, -1).every((c) => !c.components.some((x) => x.type === ComponentType.File))).toBe(true);
    expect(MESSAGE_TEXT_BUDGET).toBeLessThan(4000);
  });

  it('aucun sujet : message explicite', () => {
    expect(renderReport({ ...base, summary: { overview: '', topics: [] } }, m).map(texts).join('\n')).toContain(m.report.empty);
  });
});

describe('renderTranscriptMarkdown', () => {
  it('une réplique par paragraphe, horodatée', () => {
    expect(renderTranscriptMarkdown('Bureau', 'lundi', [{ time: '18:00:05', name: 'Alice', text: 'Bonjour.' }])).toBe(
      '# Transcription — Bureau\n\n*lundi*\n\n**[18:00:05] Alice** : Bonjour.\n',
    );
  });
});
