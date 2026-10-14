import PDFDocument from 'pdfkit';
import { orderedTopics, type ReportInput } from '../discord/embeds/report.js';
import type { Messages } from '../i18n/index.js';

/**
 * Texte accepté par les polices standard du PDF (Helvetica, encodage WinAnsi) : accents français,
 * guillemets et tirets typographiques conservés ; émojis et autres symboles retirés.
 */
export function pdfText(text: string): string {
  return text
    .replace(/<@&?\d+>/g, '') // mentions Discord résiduelles
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[^\u0009\u000A\u000D -~ -ÿŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const INK = '#1d2033';
const MUTED = '#5d6280';
const ACCENT = '#4752c4';

/**
 * Compte rendu en PDF (procès-verbal à archiver ou à diffuser hors de Discord) : mêmes contenus
 * que dans Discord — présents, synthèse, sujets dans l'ordre de l'ordre du jour avec décisions,
 * actions et questions, points non traités, trace des modèles. Responsables par leur nom.
 */
export function renderReportPdf(input: ReportInput, m: Messages): Promise<Buffer> {
  const r = m.report;
  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 }, info: { Title: pdfText(`${r.title} · ${input.title}`), Creator: 'Meeting recorder' } });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const heading = (text: string, size: number, color = INK) => doc.font('Helvetica-Bold').fontSize(size).fillColor(color).text(pdfText(text), { paragraphGap: 4 });
  const body = (text: string, color = INK) => doc.font('Helvetica').fontSize(10.5).fillColor(color).text(pdfText(text), { paragraphGap: 3, lineGap: 1.5 });
  const list = (label: string, items: readonly string[]) => {
    if (!items.length) return;
    if (label) doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(pdfText(label), { paragraphGap: 2 });
    for (const item of items) doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(`•  ${pdfText(item)}`, { indent: 10, paragraphGap: 2, lineGap: 1.5 });
    doc.moveDown(0.3);
  };

  heading(`${r.title} · ${input.title}`, 18, ACCENT);
  body(input.subtitle, MUTED);
  if (input.participants?.length) body(`${r.present} : ${input.participants.map((p) => p.name).join(', ')}`, MUTED);
  doc.moveDown(0.8);

  if (input.summaryDisabled) {
    body(r.disabled);
  } else {
    if (input.summary.overview) {
      body(input.summary.overview);
      doc.moveDown(0.6);
    }
    const { topics, notCovered } = orderedTopics(input);
    topics.forEach((topic, i) => {
      const spent = topic.agendaItemId === null ? undefined : input.durations?.get(topic.agendaItemId);
      const suffix = [topic.agendaItemId === null ? `(${r.offAgenda})` : '', spent && spent >= 60_000 ? `· ${m.format.duration(spent)}` : ''].filter(Boolean).join(' ');
      heading(`${i + 1}. ${topic.title}${suffix ? ` ${suffix}` : ''}`, 13);
      if (topic.summary) body(topic.summary);
      doc.moveDown(0.2);
      list(r.decisions, topic.decisions);
      list(r.actions, topic.actions.map((a) => `${a.what}${a.who ? ` — ${a.who}` : ''}${a.when ? ` (échéance : ${a.when})` : ''}`));
      list(r.questions, topic.openQuestions);
      doc.moveDown(0.5);
    });
    if (topics.length === 0) body(r.empty);
    if (notCovered.length) {
      heading(r.notCovered, 13);
      list('', notCovered.map((a) => a.title));
    }
  }
  doc.moveDown(0.8);
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(pdfText(input.trace));
  doc.end();
  return done;
}
