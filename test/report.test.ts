import { ComponentType, type APIContainerComponent } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { MESSAGE_TEXT_BUDGET, renderReport, renderReportMarkdown, renderTranscriptMarkdown, resolvePerson, type ReportInput } from '../src/discord/embeds/report.js';
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

  it('liens vers l’audio et l’ordre du jour du post', () => {
    const head = texts(renderReport({ ...base, audioUrl: 'https://discord.com/a', agendaUrl: 'https://discord.com/b' }, m)[0]!);
    expect(head).toContain(`🎧 [${m.report.listen}](https://discord.com/a) · 📋 [${m.report.agendaLink}](https://discord.com/b)`);
  });

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

  it('bouton « Corriger » sur le dernier message seulement, absent sans résumé', () => {
    const out = renderReport({ ...base, correctMeetingId: '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b' }, m);
    const row = out.at(-1)!.components.at(-1) as { type: number; components: Array<{ custom_id: string }> };
    expect(row.type).toBe(ComponentType.ActionRow);
    expect(row.components[0]!.custom_id).toBe('v1:report:correct:3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b');
    expect(row.components[1]!.custom_id).toBe('v1:report:regen:3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b');
    expect(renderReport(base, m).at(-1)!.components.some((c) => c.type === ComponentType.ActionRow)).toBe(false);
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

  it('résumé désactivé : compte rendu réduit, transcription jointe, sans ODJ non traité', () => {
    const out = renderReport({ ...base, summaryDisabled: true, trace: 'Transcription : vibe-pc · Résumé désactivé' }, m);
    const all = out.map(texts).join('\n');
    expect(all).toContain(m.report.disabled);
    expect(all).not.toContain('Points non traités');
    expect(all).not.toContain('### 1.');
    expect(out.at(-1)!.components.at(-1)).toMatchObject({ type: ComponentType.File });
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

describe('présents dans le vocal', () => {
  const participants = [
    { id: '111', name: 'Pierre Comble' },
    { id: '444', name: 'Zoé' },
  ];
  it('Discord : mentions dans l’en-tête (sans notification : seuls les responsables sont notifiés) ; fichier : noms', () => {
    expect(texts(renderReport({ ...base, participants }, m)[0]!)).toContain('👥 **Présents** : <@111>, <@444>');
    expect(renderReportMarkdown({ ...base, participants }, m)).toContain('👥 **Présents** : Pierre Comble, Zoé');
  });
  it('aucune présence connue : pas de ligne', () => {
    expect(texts(renderReport(base, m)[0]!)).not.toContain('Présents');
  });
});

describe('repères en direct dans le compte rendu', () => {
  it('temps passé par point (à partir d’une minute), pas pour les sujets hors ODJ', () => {
    const t = texts(renderReport({ ...base, durations: new Map([[1, 12 * 60_000], [2, 30_000]]) }, m)[0]!);
    expect(t).toContain('Budget · ⏱️ 12 min');
    expect(t).not.toMatch(/Fête · ⏱️/);
  });
  it('transcription : repères en citation, à leur place', () => {
    const md = renderTranscriptMarkdown('Bureau', 'x', [
      { time: '18:00:00', marker: "▶️ Point 1 de l'ordre du jour : Budget" },
      { time: '18:00:05', name: 'Alice', text: 'Bonjour.' },
    ]);
    expect(md).toContain("> **[18:00:00] ▶️ Point 1 de l'ordre du jour : Budget**\n\n**[18:00:05] Alice** : Bonjour.");
  });
});

describe('titre des sujets de l’ordre du jour', () => {
  it('titre exact du point (pas celui du modèle, qui y ajoute la description) ; description en italique dans le fichier seulement', () => {
    const input = {
      ...base,
      agenda: [{ id: 2, title: 'Feux d’artifice', detail: 'Font-ils des dégâts ?\nSur les *chaloupes*' }],
      summary: { overview: '', topics: [{ agendaItemId: 2, title: 'Feux d’artifice — Font-ils des dégâts ?', summary: 'Pas sûr.', decisions: [], actions: [], openQuestions: [] }] },
    };
    const t = texts(renderReport(input, m)[0]!);
    expect(t).toContain('### 1. Feux d’artifice\nPas sûr.');
    expect(t).not.toContain('Font-ils');
    expect(renderReportMarkdown(input, m)).toContain('### 1. Feux d’artifice\n*Font-ils des dégâts ?*\n*Sur les chaloupes*\nPas sûr.');
  });
});

describe('renderReportMarkdown', () => {
  it('fichier lisible hors Discord : titre, sujets dans l’ordre, responsables par leur nom, sans lien ni mention', () => {
    const md = renderReportMarkdown({ ...base, audioUrl: 'https://discord.com/x', agendaUrl: 'https://discord.com/y' }, m);
    expect(md.startsWith(`# ${m.report.title} · Bureau\n*lundi 12/10 · 42 min · 3 participants*`)).toBe(true);
    expect(md.indexOf('Budget voté')).toBeLessThan(md.indexOf('Date fixée'));
    expect(md).toContain('Réserver la salle — Marie-Anne · 📅 vendredi');
    expect(md).not.toMatch(/<@\d+>|discord\.com|-# /);
    expect(md.trimEnd().endsWith('*Transcription : vibe-pc · Résumé : qwen3 · 1 passe*')).toBe(true);
  });
});
