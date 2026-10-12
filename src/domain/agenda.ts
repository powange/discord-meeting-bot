import type { AgendaItem } from './types.js';

export const AGENDA_MAX_ITEMS = 25; // = options d'un menu déroulant Discord
export const AGENDA_TITLE_MAX = 100;
export const AGENDA_DETAIL_MAX = 1000;

export type AgendaAddCheck = { ok: true; title: string; detail: string } | { ok: false; error: 'locked' | 'full' | 'empty' | 'closed' };

export function checkAddItem(input: {
  title: string;
  detail: string;
  count: number;
  locked: boolean;
  meetingOpen: boolean;
  actorIsManager: boolean;
}): AgendaAddCheck {
  if (!input.meetingOpen) return { ok: false, error: 'closed' };
  if (input.locked && !input.actorIsManager) return { ok: false, error: 'locked' };
  if (input.count >= AGENDA_MAX_ITEMS) return { ok: false, error: 'full' };
  const title = input.title.trim().slice(0, AGENDA_TITLE_MAX);
  if (title.length === 0) return { ok: false, error: 'empty' };
  return { ok: true, title, detail: input.detail.trim().slice(0, AGENDA_DETAIL_MAX) };
}

export type MoveDirection = 'up' | 'down';

/**
 * Nouvel ordre des ids après déplacement d'un point. Renvoie `null` si le déplacement est
 * impossible (point inconnu ou déjà en bout de liste).
 */
export function moveItem(orderedIds: readonly number[], id: number, direction: MoveDirection): number[] | null {
  const from = orderedIds.indexOf(id);
  if (from === -1) return null;
  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= orderedIds.length) return null;
  const next = [...orderedIds];
  next[from] = orderedIds[to]!;
  next[to] = id;
  return next;
}

/** Positions compactes 0..n-1 dans l'ordre donné (après retrait ou déplacement). */
export function reindex(orderedIds: readonly number[]): Array<{ id: number; position: number }> {
  return orderedIds.map((id, position) => ({ id, position }));
}

export function sortAgenda<T extends Pick<AgendaItem, 'position' | 'id'>>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position || a.id - b.id);
}
