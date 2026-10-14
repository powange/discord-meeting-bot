import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorSpacingSize, type APIContainerComponent } from 'discord.js';
import { encode } from '../../domain/customId.js';
import type { MeetingSummary, Topic } from '../../ai/llm/schema.js';
import type { Messages } from '../../i18n/index.js';
import { truncate } from '../../lib/text.js';

/** Texte maximal par message Components V2 (limite Discord : 4000), avec une marge. */
export const MESSAGE_TEXT_BUDGET = 3800;

export interface ReportInput {
  title: string;
  /** Sous-titre déjà formaté (date, durée, participants). */
  subtitle: string;
  agenda: ReadonlyArray<{ id: number; title: string }>;
  summary: MeetingSummary;
  /** Temps passé sur chaque point d'ordre du jour (repères « Point suivant »), par id. */
  durations?: ReadonlyMap<number, number>;
  /** Personnes présentes dans le vocal pendant l'enregistrement (ordre d'arrivée). */
  participants?: ReadonlyArray<{ id: string; name: string }>;
  /** Nom → id Discord, pour transformer les responsables d'actions en mentions. */
  people: ReadonlyMap<string, string>;
  /** Trace des modèles utilisés. */
  trace: string;
  /** Nom de la pièce jointe de transcription (référencée dans le dernier message). */
  transcriptFile?: string;
  /** Nom de la pièce jointe PDF du compte rendu (dernier message). */
  pdfFile?: string;
  /** Lien vers le message de l'audio complet. */
  audioUrl?: string;
  /** Aucun LLM configuré : compte rendu réduit (audio et transcription). */
  summaryDisabled?: boolean;
  /** Réunion dont le compte rendu peut être corrigé : bouton « Corriger » sur le dernier message. */
  correctMeetingId?: string;
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

/**
 * « Alice » → <@id> si le nom correspond à un participant (nom complet, ou prénom s'il est
 * unique) ; sinon le nom tel quel.
 */
export function resolvePerson(name: string, people: ReadonlyMap<string, string>): string {
  const target = normalize(name);
  for (const [n, id] of people) if (normalize(n) === target) return `<@${id}>`;
  const byFirst = [...people].filter(([n]) => normalize(n).split(/\s+/)[0] === target);
  return byFirst.length === 1 ? `<@${byFirst[0]![1]}>` : name;
}

function topicSection(topic: Topic, index: number, input: ReportInput, m: Messages): string {
  const r = m.report;
  const spent = topic.agendaItemId === null ? undefined : input.durations?.get(topic.agendaItemId);
  const lines = [
    `### ${index}. ${truncate(topic.title, 200)}${topic.agendaItemId === null ? ` *(${r.offAgenda})*` : ''}${spent && spent >= 60_000 ? ` · ⏱️ ${m.format.duration(spent)}` : ''}`,
  ];
  if (topic.summary) lines.push(topic.summary);
  if (topic.decisions.length) lines.push(`**${r.decisions}**`, ...topic.decisions.map((d) => `- ✅ ${d}`));
  if (topic.actions.length) {
    lines.push(
      `**${r.actions}**`,
      ...topic.actions.map((a) => `- ☐ ${a.what}${a.who ? ` — ${resolvePerson(a.who, input.people)}` : ''}${a.when ? ` · 📅 ${a.when}` : ''}`),
    );
  }
  if (topic.openQuestions.length) lines.push(`**${r.questions}**`, ...topic.openQuestions.map((q) => `- ❔ ${q}`));
  return lines.join('\n');
}

/** Coupe un texte trop long sur des fins de ligne (dernier recours : coupe brute). */
function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const piece = line.length > max ? truncate(line, max) : line;
    if (current && current.length + 1 + piece.length > max) {
      parts.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Sections du compte rendu (titre, aperçu, sujets, points non abordés), en Markdown Discord. */
/** Sujets dans l'ordre de l'ordre du jour, puis hors ODJ ; et les points de l'ODJ non abordés. */
export function orderedTopics(input: Pick<ReportInput, 'agenda' | 'summary'>): { topics: Topic[]; notCovered: Array<{ id: number; title: string }> } {
  const order = new Map(input.agenda.map((a, i) => [a.id, i]));
  const topics = [...input.summary.topics].sort(
    (a, b) => (a.agendaItemId === null ? 1e6 : (order.get(a.agendaItemId) ?? 1e6)) - (b.agendaItemId === null ? 1e6 : (order.get(b.agendaItemId) ?? 1e6)),
  );
  const covered = new Set(topics.map((t) => t.agendaItemId));
  return { topics, notCovered: input.agenda.filter((a) => !covered.has(a.id)) };
}

function reportSections(input: ReportInput, m: Messages, plain = false): string[] {
  const r = m.report;
  const { topics, notCovered } = orderedTopics(input);

  // Présents : mentions dans Discord (noms à jour, sans notification), noms dans le fichier.
  const present = input.participants?.length
    ? `\n👥 **${r.present}** : ${input.participants.map((p) => (plain ? p.name : `<@${p.id}>`)).join(', ')}`
    : '';
  const sections: string[] = [
    `## 📝 ${r.title} · ${truncate(input.title, 150)}\n-# ${input.subtitle}${input.audioUrl ? ` · 🎧 [${r.listen}](${input.audioUrl})` : ''}${present}`,
  ];
  if (input.summaryDisabled) {
    sections.push(r.disabled);
  } else {
    if (input.summary.overview) sections.push(input.summary.overview);
    topics.forEach((t, i) => sections.push(topicSection(t, i + 1, input, m)));
    if (topics.length === 0) sections.push(r.empty);
    if (notCovered.length) sections.push(`### ${r.notCovered}\n${notCovered.map((a) => `- ${a.title}`).join('\n')}`);
  }
  return sections;
}

/**
 * Compte rendu publié dans le post : un ou plusieurs messages (Components V2), découpés par
 * sujet pour rester sous les limites de Discord. Les sujets suivent l'ordre du jour, puis les
 * sujets hors ODJ ; les points de l'ODJ non abordés sont listés à part.
 */
export function renderReport(input: ReportInput, m: Messages): APIContainerComponent[] {
  const r = m.report;
  const sections = reportSections(input, m);
  const footer = `-# ${input.trace}`;

  // Répartition des sections en messages, chacun sous le budget de texte.
  const messages: string[][] = [[]];
  let size = 0;
  for (const section of sections.flatMap((s) => splitText(s, MESSAGE_TEXT_BUDGET - 200))) {
    if (size + section.length > MESSAGE_TEXT_BUDGET - footer.length && messages.at(-1)!.length > 0) {
      messages.push([]);
      size = 0;
    }
    messages.at(-1)!.push(section);
    size += section.length;
  }
  messages.at(-1)!.push(footer);

  return messages.map((texts, i) => {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    texts.forEach((text, j) => {
      if (j > 0) container.addSeparatorComponents((s) => s.setSpacing(j === 1 && i === 0 ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small));
      container.addTextDisplayComponents((t) => t.setContent(text));
    });
    if (i === messages.length - 1 && input.pdfFile) container.addFileComponents((f) => f.setURL(`attachment://${input.pdfFile}`));
    if (i === messages.length - 1 && input.transcriptFile) container.addFileComponents((f) => f.setURL(`attachment://${input.transcriptFile}`));
    if (i === messages.length - 1 && input.correctMeetingId) {
      container.addActionRowComponents((row: ActionRowBuilder<ButtonBuilder>) =>
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(encode({ type: 'report.correct', meetingId: input.correctMeetingId! }))
            .setLabel(r.correct)
            .setEmoji('✏️')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(encode({ type: 'report.regen', meetingId: input.correctMeetingId! }))
            .setLabel(r.regen)
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Secondary),
        ),
      );
    }
    return container.toJSON();
  });
}

/** Ligne de la transcription : une réplique, ou un repère pris en direct (point en cours, note). */
export type TranscriptEntry = { time: string; name: string; text: string } | { time: string; marker: string };

/** Transcription complète en Markdown (pièce jointe). */
export function renderTranscriptMarkdown(title: string, subtitle: string, lines: readonly TranscriptEntry[]): string {
  return [
    `# Transcription — ${title}`,
    '',
    `*${subtitle}*`,
    '',
    ...lines.map((l) => ('marker' in l ? `> **[${l.time}] ${l.marker}**\n` : `**[${l.time}] ${l.name}** : ${l.text}\n`)),
  ].join('\n');
}

/**
 * Compte rendu en fichier Markdown (copie vers le stockage du serveur) : mêmes sections que dans
 * Discord, responsables d'actions par leur nom, petits textes Discord (« -# ») en italique.
 */
export function renderReportMarkdown(input: ReportInput, m: Messages): string {
  const { audioUrl: _link, ...rest } = input;
  const sections = reportSections({ ...rest, people: new Map() }, m, true);
  const text = [...sections, `-# ${input.trace}`].join('\n\n');
  return `${text
    .replace(/^## 📝 /m, '# ')
    .split('\n')
    .map((line) => (line.startsWith('-# ') ? `*${line.slice(3)}*` : line))
    .join('\n')}\n`;
}
