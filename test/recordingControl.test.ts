import type { APIButtonComponentWithCustomId } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { renderRecordingControl } from '../src/discord/embeds/recordingControl.js';
import { decode } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');
const id = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
const button = (c: ReturnType<typeof renderRecordingControl>) => c.components[0]?.components[0] as APIButtonComponentWithCustomId | undefined;

describe('renderRecordingControl', () => {
  it('réunion en cours, pas d’enregistrement : bouton Enregistrer', () => {
    const c = renderRecordingControl({ id, status: 'live' }, null, m);
    expect(c.content).toBe(m.control.idle);
    expect(decode(button(c)!.custom_id)).toEqual({ type: 'rec.start', meetingId: id });
  });
  it('enregistrement en cours : bouton Arrêter', () => {
    const c = renderRecordingControl({ id, status: 'live' }, new Date('2026-10-15T16:00:00Z'), m);
    expect(c.content).toContain('Enregistrement en cours');
    expect(decode(button(c)!.custom_id)).toEqual({ type: 'rec.stop', meetingId: id });
  });
  it('réunion close : plus de bouton', () => {
    const c = renderRecordingControl({ id, status: 'ended' }, null, m);
    expect(c.content).toBe(m.control.closed);
    expect(c.components).toEqual([]);
  });

  describe('pendant l’enregistrement : repères en direct', () => {
    const since = new Date('2026-10-15T16:00:00Z');
    const agenda = [
      { id: 10, title: 'Budget' },
      { id: 11, title: 'Fête' },
    ];
    const ids = (c: ReturnType<typeof renderRecordingControl>) =>
      c.components.flatMap((row) => row.components as unknown[]).map((x) => decode((x as { custom_id: string }).custom_id)?.type);
    const labels = (c: ReturnType<typeof renderRecordingControl>) => c.components.flatMap((row) => row.components as unknown[]).map((x) => (x as { label?: string }).label);

    it('aucun repère : invitation à poser le premier, « Point suivant : 1. Budget », note et choix direct', () => {
      const c = renderRecordingControl({ id, status: 'live' }, since, m, { agenda, markers: [] });
      expect(c.content).toContain(m.control.noPointYet);
      expect(ids(c)).toEqual(['rec.stop', 'rec.next', 'rec.note', 'rec.goto']);
      expect(labels(c)).toContain('Point suivant : 1. Budget');
    });

    it('point en cours affiché, notes comptées ; au dernier point, le suivant est la fin de l’ordre du jour', () => {
      const markers = [
        { kind: 'agenda' as const, at: since, agendaItemId: 11, text: '', who: null },
        { kind: 'decision' as const, at: since, agendaItemId: null, text: 'ok', who: null },
      ];
      const c = renderRecordingControl({ id, status: 'live' }, since, m, { agenda, markers });
      expect(c.content).toContain('▶️ Point en cours : **2. Fête**');
      expect(c.content).toContain('📝 1 note prise en direct');
      expect(labels(c)).toContain('Point suivant : fin de l’ordre du jour');
    });

    it('sans ordre du jour : seulement la note ; enregistrement arrêté : rien de tout ça', () => {
      expect(ids(renderRecordingControl({ id, status: 'live' }, since, m, { agenda: [], markers: [] }))).toEqual(['rec.stop', 'rec.note']);
      expect(ids(renderRecordingControl({ id, status: 'live' }, null, m, { agenda, markers: [] }))).toEqual(['rec.start']);
    });
  });
});
