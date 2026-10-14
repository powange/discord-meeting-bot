import { describe, expect, it } from 'vitest';
import { currentPoint, interleave, markerText, nextPoint, pointDurations, type Marker } from '../src/domain/markers.js';

const agenda = [
  { id: 10, title: 'Budget' },
  { id: 11, title: 'Fête' },
  { id: 12, title: 'Divers' },
];
const at = (min: number) => new Date(Date.UTC(2026, 9, 15, 16, min));
const point = (min: number, agendaItemId: number | null): Marker => ({ kind: 'agenda', at: at(min), agendaItemId, text: '', who: null });
const note = (min: number, kind: Marker['kind'], text: string, who: string | null = null): Marker => ({ kind, at: at(min), agendaItemId: null, text, who });

describe('repères en direct', () => {
  it('point suivant : le premier au départ, puis dans l’ordre, puis fin de l’ordre du jour', () => {
    expect(nextPoint(agenda, [])).toBe(10);
    expect(nextPoint(agenda, [point(0, 10)])).toBe(11);
    expect(nextPoint(agenda, [point(0, 10), point(5, 11), point(9, 12)])).toBeNull();
    expect(nextPoint([], [])).toBeNull();
  });

  it('après un détour hors ordre du jour : reprise au premier point pas encore abordé', () => {
    expect(nextPoint(agenda, [point(0, 10), point(4, null)])).toBe(11);
    expect(nextPoint(agenda, [point(0, 10), point(4, 11), point(6, 12), point(8, null)])).toBeNull();
  });

  it('les notes ne changent pas le point en cours', () => {
    expect(currentPoint([point(0, 10), note(3, 'decision', 'ok')])).toEqual({ agendaItemId: 10, since: at(0) });
    expect(currentPoint([note(1, 'note', 'x')])).toBeUndefined();
  });

  it('temps par point : jusqu’au repère suivant ou la fin ; un point repris cumule', () => {
    const d = pointDurations([point(0, 10), point(12, 11), point(20, 10), point(25, null)], at(40));
    expect(Object.fromEntries(d)).toEqual({ 10: 17 * 60_000, 11: 8 * 60_000 });
  });

  it('repères en clair pour le résumé et la transcription', () => {
    expect(markerText(point(0, 11), agenda)).toBe("▶️ Point 2 de l'ordre du jour : Fête");
    expect(markerText(point(0, null), agenda)).toBe("▶️ Fin de l'ordre du jour (sujets hors ordre du jour)");
    expect(markerText(note(0, 'action', 'Réserver la salle', 'Marie'), agenda)).toBe('📝 Action notée en direct : Réserver la salle — responsable : Marie');
    expect(markerText(note(0, 'decision', 'Budget adopté'), agenda)).toBe('📝 Décision notée en direct : Budget adopté');
  });

  it('répliques et repères entrelacés par heure, le repère avant une réplique de la même seconde', () => {
    expect(interleave([{ at: at(1), value: 'a' }, { at: at(3), value: 'b' }], [{ at: at(3), value: 'M' }, { at: at(0), value: 'P' }])).toEqual(['P', 'a', 'M', 'b']);
  });
});
