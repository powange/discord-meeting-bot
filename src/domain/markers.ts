/** Repère pris en direct pendant l'enregistrement (voir la table meeting_markers). */
export interface Marker {
  kind: 'agenda' | 'decision' | 'action' | 'note';
  at: Date;
  /** Repère « agenda » : point commencé ; null = fin de l'ordre du jour (hors ODJ). */
  agendaItemId: number | null;
  text: string;
  who: string | null;
}

export const NOTE_KINDS = ['decision', 'action', 'note'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Point en cours : le dernier repère « agenda » (null : hors ODJ ; undefined : aucun repère encore). */
export function currentPoint(markers: readonly Marker[]): { agendaItemId: number | null; since: Date } | undefined {
  const last = markers.filter((mk) => mk.kind === 'agenda').at(-1);
  return last ? { agendaItemId: last.agendaItemId, since: last.at } : undefined;
}

/**
 * Point suivant dans l'ordre du jour : le premier au départ, puis celui qui suit le point en cours.
 * Après le dernier (ou depuis « hors ODJ » une fois l'ordre du jour fini) : null, fin de l'ordre du jour.
 */
export function nextPoint(agenda: ReadonlyArray<{ id: number }>, markers: readonly Marker[]): number | null {
  if (agenda.length === 0) return null;
  const current = currentPoint(markers);
  if (!current) return agenda[0]!.id;
  if (current.agendaItemId === null) {
    // Hors ODJ : reprendre au premier point qui n'a pas encore été abordé.
    const seen = new Set(markers.filter((mk) => mk.kind === 'agenda').map((mk) => mk.agendaItemId));
    return agenda.find((a) => !seen.has(a.id))?.id ?? null;
  }
  const index = agenda.findIndex((a) => a.id === current.agendaItemId);
  return index >= 0 && index + 1 < agenda.length ? agenda[index + 1]!.id : null;
}

/**
 * Temps passé sur chaque point : d'un repère « agenda » au repère suivant, ou jusqu'à `endAt`
 * (fin de l'enregistrement). Un point repris plusieurs fois cumule ses durées.
 */
export function pointDurations(markers: readonly Marker[], endAt: Date): Map<number, number> {
  const points = markers.filter((mk) => mk.kind === 'agenda').sort((a, b) => a.at.getTime() - b.at.getTime());
  const durations = new Map<number, number>();
  points.forEach((mk, i) => {
    if (mk.agendaItemId === null) return;
    const end = points[i + 1]?.at ?? endAt;
    const ms = Math.max(0, end.getTime() - mk.at.getTime());
    durations.set(mk.agendaItemId, (durations.get(mk.agendaItemId) ?? 0) + ms);
  });
  return durations;
}

/**
 * Repère en une ligne, au format de la transcription (« [18:12:30] … »), pour le résumé et le
 * fichier de transcription. `position` : numéro du point dans l'ordre du jour (1, 2…).
 */
export function markerText(mk: Marker, agenda: ReadonlyArray<{ id: number; title: string }>): string {
  if (mk.kind === 'agenda') {
    const index = agenda.findIndex((a) => a.id === mk.agendaItemId);
    return index >= 0 ? `▶️ Point ${index + 1} de l'ordre du jour : ${agenda[index]!.title}` : "▶️ Fin de l'ordre du jour (sujets hors ordre du jour)";
  }
  if (mk.kind === 'decision') return `📝 Décision notée en direct : ${mk.text}`;
  if (mk.kind === 'action') return `📝 Action notée en direct : ${mk.text}${mk.who ? ` — responsable : ${mk.who}` : ''}`;
  return `📝 Note prise en direct : ${mk.text}`;
}

/** Entrelace répliques et repères par heure (à heure égale, le repère d'abord). */
export function interleave<T>(lines: ReadonlyArray<{ at: Date; value: T }>, markers: ReadonlyArray<{ at: Date; value: T }>): T[] {
  return [...markers.map((x) => ({ ...x, order: 0 })), ...lines.map((x) => ({ ...x, order: 1 }))]
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.order - b.order)
    .map((x) => x.value);
}
