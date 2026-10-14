import { describe, expect, it } from 'vitest';
import { renderRecordingControl, type ControlState } from '../src/discord/embeds/recordingControl.js';
import { decode } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');
const id = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
const since = new Date('2026-10-15T16:00:00Z');
const agenda = [
  { id: 10, title: 'Budget' },
  { id: 11, title: 'Fête' },
];
type Rendered = ReturnType<typeof renderRecordingControl>;
const all = (c: Rendered) => c.components.flatMap((row) => row.components as unknown[]) as Array<{ custom_id?: string; label?: string }>;
const ids = (c: Rendered) => all(c).map((x) => (x.custom_id ? decode(x.custom_id)?.type : undefined));
const labels = (c: Rendered) => all(c).map((x) => x.label);
const rec = (extra: Partial<Extract<ControlState, { kind: 'rec' }>> = {}): ControlState => ({ kind: 'rec', startedAt: since, startedBy: 'Pierre Comble', ...extra });

describe('message à boutons de l’enregistrement', () => {
  it('non démarré : bouton Enregistrer', () => {
    const c = renderRecordingControl(id, { kind: 'idle' }, m);
    expect(c.content).toBe(m.control.idle);
    expect(ids(c)).toEqual(['rec.start']);
  });

  it('en cours : avertissement ⚠️ (qui l’a lancé), Point suivant, Note, choix direct, puis Arrêter et Mon choix', () => {
    const c = renderRecordingControl(id, rec({ live: { agenda, markers: [] } }), m);
    expect(c.content.startsWith('⚠️ **Cette réunion est enregistrée** · lancé par Pierre Comble')).toBe(true);
    expect(c.content).toContain(m.control.noPointYet);
    expect(c.content.split('\n').at(-1)).toMatch(/^-# Vous ne voulez pas être enregistré/);
    expect(ids(c)).toEqual(['rec.next', 'rec.note', 'rec.goto', 'rec.stop', 'consent.open']);
    expect(labels(c)).toContain('Point suivant : 1. Budget');
  });

  it('point en cours affiché, notes comptées ; au dernier point, le suivant est la fin de l’ordre du jour', () => {
    const markers = [
      { kind: 'agenda' as const, at: since, agendaItemId: 11, text: '', who: null },
      { kind: 'decision' as const, at: since, agendaItemId: null, text: 'ok', who: null },
    ];
    const c = renderRecordingControl(id, rec({ live: { agenda, markers } }), m);
    expect(c.content).toContain('▶️ Point en cours : **2. Fête**');
    expect(c.content).toContain('📝 1 note prise en direct');
    expect(labels(c)).toContain('Point suivant : fin de l’ordre du jour');
  });

  it('sans ordre du jour : Note, Arrêter, Mon choix', () => {
    expect(ids(renderRecordingControl(id, rec({ live: { agenda: [], markers: [] } }), m))).toEqual(['rec.note', 'rec.stop', 'consent.open']);
  });

  it('arrêté : qui l’a arrêté et « Reprendre l’enregistrement » ; interrompu : avertissement', () => {
    const stopped = renderRecordingControl(id, { kind: 'stopped', stoppedBy: 'Pierre Comble', reason: 'arrêt manuel', interrupted: false }, m);
    expect(stopped.content).toBe('⏹️ **Enregistrement arrêté** · par Pierre Comble');
    expect(labels(stopped)).toEqual([m.buttons.resumeRecording]);
    expect(ids(stopped)).toEqual(['rec.start']);
    const cut = renderRecordingControl(id, { kind: 'stopped', stoppedBy: null, reason: 'déconnexion du vocal', interrupted: true }, m);
    expect(cut.content).toContain('⚠️ **Enregistrement interrompu** · déconnexion du vocal');
  });

  it('message dépassé (figé) : sans boutons ; la session en cours devient « Enregistré de … à … »', () => {
    const frozen = renderRecordingControl(id, rec({ endedAt: new Date('2026-10-15T16:45:00Z') }), m, true);
    expect(frozen.components).toEqual([]);
    expect(frozen.content).toBe('🎙️ Enregistré de <t:1792080000:t> à <t:1792082700:t> · lancé par Pierre Comble');
    expect(renderRecordingControl(id, { kind: 'stopped', stoppedBy: null, reason: 'vocal vide', interrupted: false }, m, true).components).toEqual([]);
  });
});
