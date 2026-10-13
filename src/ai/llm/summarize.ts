import { chunkLines, estimateTokens } from '../../domain/transcript.js';
import type { ChatMessage } from './client.js';
import type { JsonLlm } from './failover.js';
import { meetingSummarySchema, type MeetingSummary, type Topic } from './schema.js';

export interface SummaryContext {
  title: string;
  description: string;
  date: string;
  participants: readonly string[];
  agenda: ReadonlyArray<{ id: number; title: string; detail: string }>;
  /** Vocabulaire du serveur : orthographe de référence des noms propres et du jargon. */
  vocabulary?: readonly string[];
  /** Consignes de correction de l'organisateur, prioritaires sur la transcription. */
  corrections?: readonly string[];
}

export interface SummarizeResult {
  summary: MeetingSummary;
  passes: number;
  models: string[];
}

const FORMAT = `Réponds uniquement avec un objet JSON de la forme :
{
  "overview": "synthèse de la réunion en 2 à 4 phrases",
  "topics": [
    {
      "agendaItemId": <numéro du point d'ordre du jour (1, 2…), ou null pour un sujet hors ordre du jour>,
      "title": "titre du sujet",
      "summary": "ce qui a été dit, en quelques phrases",
      "decisions": ["décision prise", ...],
      "actions": [{ "what": "tâche", "who": "nom du participant ou null", "when": "échéance en clair ou null" }],
      "openQuestions": ["question restée sans réponse", ...]
    }
  ]
}`;

const RULES = `Règles :
- Écris en français, de façon factuelle et concise, même si la réunion s'est tenue dans une autre langue ou en plusieurs langues.
- N'invente rien : uniquement ce qui figure dans la transcription. Une transcription automatique contient des erreurs : corrige les mots manifestement mal reconnus, sans changer le sens.
- Un sujet = une question discutée. Rattache-le à un point de l'ordre du jour (son numéro dans agendaItemId) seulement s'il traite vraiment de ce point, même abordé dans le désordre ou en d'autres termes.
- Tout autre sujet (digression, autre projet, sujet évoqué en passant) est un sujet distinct hors ordre du jour (agendaItemId null), avec un titre court que tu rédiges et ses propres décisions et actions. Ne le fusionne jamais dans un point de l'ordre du jour, même s'il a été évoqué juste après ou par les mêmes personnes.
- Un point de l'ordre du jour non abordé n'apparaît pas.
- Une décision est un choix acté par le groupe ; une action est une tâche confiée (who = nom exact d'un participant, ou null).
- Listes vides si rien de tel n'a été dit.`;

/** Consignes de l'organisateur, placées dans le prompt système (prioritaires). */
export function correctionsBlock(corrections: readonly string[] | undefined): string {
  if (!corrections?.length) return '';
  return `\n\nConsignes de l'organisateur de la réunion, à appliquer en priorité (elles corrigent la transcription ou un précédent résumé) :\n${corrections.map((c) => `- ${c}`).join('\n')}`;
}

function contextBlock(ctx: SummaryContext): string {
  const agenda = ctx.agenda.length
    ? ctx.agenda.map((a, i) => `${i + 1}. ${a.title}${a.detail ? ` — ${a.detail}` : ''}`).join('\n')
    : '(aucun ordre du jour)';
  return `Réunion : ${ctx.title}${ctx.description ? `\nDescription : ${ctx.description}` : ''}
Date : ${ctx.date}
Participants : ${ctx.participants.join(', ') || '(inconnus)'}${ctx.vocabulary?.length ? `\nVocabulaire (orthographe correcte des noms et termes) : ${ctx.vocabulary.join(', ')}` : ''}
Ordre du jour :
${agenda}`;
}

/**
 * Résumé structuré par point d'ordre du jour. Une réunion longue est résumée en plusieurs
 * passes : chaque morceau de transcription donne des notes partielles (même format), puis les
 * notes sont fusionnées (par paquets si nécessaire) jusqu'à un résumé unique.
 */
export async function summarizeMeeting(
  llm: JsonLlm,
  ctx: SummaryContext,
  lines: readonly string[],
  chunkTokens: number,
  onProgress: (pass: number, total: number) => void = () => undefined,
  signal?: AbortSignal,
): Promise<SummarizeResult> {
  const models = new Set<string>();
  const run = async (messages: ChatMessage[]) => {
    const r = await llm.json(messages, meetingSummarySchema, signal);
    models.add(r.deployment ? `${r.model} (${r.deployment})` : r.model);
    return r.value;
  };
  const system: ChatMessage = {
    role: 'system',
    content: `Tu rédiges le compte rendu d'une réunion à partir de sa transcription.\n${RULES}${correctionsBlock(ctx.corrections)}\n\n${FORMAT}`,
  };

  const chunks = chunkLines(lines, chunkTokens);
  // Passes : une par morceau, puis les fusions (estimées pour l'affichage).
  const estimatedTotal = chunks.length === 1 ? 1 : chunks.length + Math.max(1, Math.ceil(chunks.length / 4));
  let pass = 0;

  if (chunks.length === 1) {
    onProgress(++pass, estimatedTotal);
    const summary = await run([system, { role: 'user', content: `${contextBlock(ctx)}\n\nTranscription :\n${chunks[0]!.join('\n')}` }]);
    return { summary: sanitize(summary, ctx), passes: pass, models: [...models] };
  }

  // Passe « map » : notes partielles par morceau.
  let partials: MeetingSummary[] = [];
  for (const [i, chunk] of chunks.entries()) {
    onProgress(++pass, estimatedTotal);
    partials.push(
      await run([
        system,
        {
          role: 'user',
          content: `${contextBlock(ctx)}\n\nVoici l'extrait ${i + 1}/${chunks.length} de la transcription. Résume uniquement cet extrait (même format) ; une fusion suivra.\n\nTranscription :\n${chunk.join('\n')}`,
        },
      ]),
    );
  }

  // Passes « reduce » : fusion par paquets tenant dans la fenêtre, jusqu'à un seul résumé.
  while (partials.length > 1) {
    const groups: MeetingSummary[][] = [];
    let current: MeetingSummary[] = [];
    let size = 0;
    for (const p of partials) {
      const t = estimateTokens(JSON.stringify(p));
      if (current.length >= 2 && size + t > chunkTokens) {
        groups.push(current);
        current = [];
        size = 0;
      }
      current.push(p);
      size += t;
    }
    groups.push(current);
    const merged: MeetingSummary[] = [];
    for (const group of groups) {
      if (group.length === 1) {
        merged.push(group[0]!);
        continue;
      }
      onProgress(++pass, Math.max(estimatedTotal, pass));
      merged.push(
        await run([
          system,
          {
            role: 'user',
            content: `${contextBlock(ctx)}\n\nVoici ${group.length} résumés partiels successifs de la même réunion. Fusionne-les en un seul (même format) : regroupe par sujet, supprime les doublons, garde toutes les décisions et actions.\n\n${group.map((p, i) => `Résumé ${i + 1} :\n${JSON.stringify(p)}`).join('\n\n')}`,
          },
        ]),
      );
    }
    partials = merged;
  }
  return { summary: sanitize(partials[0]!, ctx), passes: pass, models: [...models] };
}

/**
 * Rattachement fiable à l'ordre du jour : le modèle désigne les points par leur numéro (1, 2…),
 * converti ici en id. Un sujet sans numéro valide mais dont le titre est celui d'un point y est
 * rattaché (les petits modèles se trompent de numéro). Plusieurs sujets pour un même point : ceux
 * dont le titre est celui du point y sont fusionnés, les autres sont des sujets distincts, hors ODJ
 * (un modèle range volontiers une digression dans le point voisin). Les sujets vides sont retirés.
 */
export function sanitize(summary: MeetingSummary, ctx: SummaryContext): MeetingSummary {
  const titleOf = new Map(ctx.agenda.map((a) => [a.id, normalizeTitle(a.title)]));
  const sameTitle = (topicTitle: string, agendaId: number): boolean => {
    const a = titleOf.get(agendaId)!;
    const t = normalizeTitle(topicTitle);
    return a === t || (a.length >= 4 && t.length >= 4 && (a.includes(t) || t.includes(a)));
  };
  const resolve = (t: Topic): number | null => {
    const n = t.agendaItemId;
    if (n !== null && Number.isInteger(n) && n >= 1 && n <= ctx.agenda.length) return ctx.agenda[n - 1]!.id;
    const close = ctx.agenda.filter((a) => sameTitle(t.title, a.id));
    return close.length === 1 ? close[0]!.id : null;
  };

  const kept = summary.topics
    .filter((t) => t.summary || t.decisions.length || t.actions.length || t.openQuestions.length)
    .map((t) => ({ ...t, agendaItemId: resolve(t) }));
  // Sujet principal de chaque point : le premier qui en porte le titre, sinon le premier rattaché.
  const primary = new Map<number, Topic>();
  for (const t of kept) if (t.agendaItemId !== null && !primary.has(t.agendaItemId) && sameTitle(t.title, t.agendaItemId)) primary.set(t.agendaItemId, t);
  for (const t of kept) if (t.agendaItemId !== null && !primary.has(t.agendaItemId)) primary.set(t.agendaItemId, t);

  const topics: Topic[] = [];
  for (const t of kept) {
    const main = t.agendaItemId === null ? undefined : primary.get(t.agendaItemId);
    if (!main || main === t) {
      topics.push(t);
    } else if (sameTitle(t.title, t.agendaItemId!)) {
      main.summary = [main.summary, t.summary].filter(Boolean).join(' ');
      main.decisions = [...main.decisions, ...t.decisions];
      main.actions = [...main.actions, ...t.actions];
      main.openQuestions = [...main.openQuestions, ...t.openQuestions];
    } else {
      topics.push({ ...t, agendaItemId: null });
    }
  }
  return { overview: summary.overview, topics };
}

/** « L'Apothicaire ! » → « l apothicaire » : casse, accents et ponctuation ignorés. */
function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
