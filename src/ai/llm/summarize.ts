import { chunkLines, estimateTokens } from '../../domain/transcript.js';
import type { ChatMessage, LlmClient } from './client.js';
import { meetingSummarySchema, type MeetingSummary } from './schema.js';

export interface SummaryContext {
  title: string;
  description: string;
  date: string;
  participants: readonly string[];
  agenda: ReadonlyArray<{ id: number; title: string; detail: string }>;
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
      "agendaItemId": <id du point d'ordre du jour, ou null pour un sujet hors ordre du jour>,
      "title": "titre du sujet",
      "summary": "ce qui a été dit, en quelques phrases",
      "decisions": ["décision prise", ...],
      "actions": [{ "what": "tâche", "who": "nom du participant ou null", "when": "échéance en clair ou null" }],
      "openQuestions": ["question restée sans réponse", ...]
    }
  ]
}`;

const RULES = `Règles :
- Écris en français, de façon factuelle et concise.
- N'invente rien : uniquement ce qui figure dans la transcription. Une transcription automatique contient des erreurs : corrige les mots manifestement mal reconnus, sans changer le sens.
- Rattache chaque sujet au point d'ordre du jour correspondant (agendaItemId) ; un point non abordé n'apparaît pas.
- Une décision est un choix acté par le groupe ; une action est une tâche confiée (who = nom exact d'un participant, ou null).
- Listes vides si rien de tel n'a été dit.`;

/** Consignes de l'organisateur, placées dans le prompt système (prioritaires). */
export function correctionsBlock(corrections: readonly string[] | undefined): string {
  if (!corrections?.length) return '';
  return `\n\nConsignes de l'organisateur de la réunion, à appliquer en priorité (elles corrigent la transcription ou un précédent résumé) :\n${corrections.map((c) => `- ${c}`).join('\n')}`;
}

function contextBlock(ctx: SummaryContext): string {
  const agenda = ctx.agenda.length
    ? ctx.agenda.map((a) => `- [id ${a.id}] ${a.title}${a.detail ? ` — ${a.detail}` : ''}`).join('\n')
    : '(aucun ordre du jour)';
  return `Réunion : ${ctx.title}${ctx.description ? `\nDescription : ${ctx.description}` : ''}
Date : ${ctx.date}
Participants : ${ctx.participants.join(', ') || '(inconnus)'}
Ordre du jour :
${agenda}`;
}

/**
 * Résumé structuré par point d'ordre du jour. Une réunion longue est résumée en plusieurs
 * passes : chaque morceau de transcription donne des notes partielles (même format), puis les
 * notes sont fusionnées (par paquets si nécessaire) jusqu'à un résumé unique.
 */
export async function summarizeMeeting(
  llm: LlmClient,
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

/** Ids d'ordre du jour inconnus ramenés à null ; sujets vides retirés. */
export function sanitize(summary: MeetingSummary, ctx: SummaryContext): MeetingSummary {
  const ids = new Set(ctx.agenda.map((a) => a.id));
  return {
    overview: summary.overview,
    topics: summary.topics
      .map((t) => ({ ...t, agendaItemId: t.agendaItemId !== null && ids.has(t.agendaItemId) ? t.agendaItemId : null }))
      .filter((t) => t.summary || t.decisions.length || t.actions.length || t.openQuestions.length),
  };
}
