import { z } from 'zod';

const text = z.string().trim();
const list = z.array(text.min(1)).default([]);

export const actionSchema = z.object({
  what: text.min(1),
  /** Nom tel que prononcé ou tel qu'il figure dans la transcription ; null si personne n'est désigné. */
  who: text.nullable().default(null),
  /** Échéance en clair (« vendredi », « fin octobre ») ; null si aucune. */
  when: text.nullable().default(null),
});

export const topicSchema = z.object({
  /** Id du point d'ordre du jour, ou null pour un sujet hors ODJ. */
  agendaItemId: z.number().int().nullable().default(null),
  title: text.min(1),
  summary: text.default(''),
  decisions: list,
  actions: z.array(actionSchema).default([]),
  openQuestions: list,
});

export const meetingSummarySchema = z.object({
  overview: text.default(''),
  topics: z.array(topicSchema).default([]),
});

export type ActionItem = z.infer<typeof actionSchema>;
export type Topic = z.infer<typeof topicSchema>;
export type MeetingSummary = z.infer<typeof meetingSummarySchema>;
