import { describe, expect, it } from 'vitest';
import { renderLiveControl, renderRecordingControl, type ControlState } from '../src/discord/embeds/recordingControl.js';
import { decode } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');
const e = m.control.embed;
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
const shown = (c: Rendered) => c.embeds[0]!;
const rec = (extra: Partial<Extract<ControlState, { kind: 'rec' }>> = {}): ControlState => ({ kind: 'rec', startedAt: since, startedBy: 'Pierre Comble', ...extra });

describe('messages de l’enregistrement (embeds)', () => {
  it('non démarré : embed et bouton Enregistrer', () => {
    const c = renderRecordingControl(id, { kind: 'idle' }, m);
    expect(shown(c).title).toBe(e.idleTitle);
    expect(ids(c)).toEqual(['rec.start']);
  });

  it('en cours : avertissement ⚠️ en rouge (qui l’a lancé, à quelle heure), refus en pied ; Arrêter et Mon choix', () => {
    const c = renderRecordingControl(id, rec(), m);
    expect(shown(c)).toMatchObject({ title: e.recTitle, color: 0xed4245, footer: { text: e.recFooter } });
    expect(shown(c).description).toBe('Lancé par **Pierre Comble** à <t:1792080000:t>.\nUne piste audio par participant, uniquement pour rédiger le compte rendu.');
    expect(ids(c)).toEqual(['rec.stop', 'consent.open']);
  });

  it('suivi de l’ordre du jour (message à part) : invitation, Point suivant, Note, choix direct', () => {
    const c = renderLiveControl(id, { agenda, markers: [] }, m);
    expect(shown(c)).toMatchObject({ title: m.control.liveTitle, description: m.control.noPointYet, color: 0x5865f2 });
    expect(ids(c)).toEqual(['rec.next', 'rec.note', 'rec.goto']);
    expect(labels(c)).toContain('Point suivant : 1. Budget');
  });

  it('suivi : point en cours, notes comptées ; au dernier point, le suivant est la fin de l’ordre du jour ; figé : gris, sans boutons', () => {
    const markers = [
      { kind: 'agenda' as const, at: since, agendaItemId: 11, text: '', who: null },
      { kind: 'decision' as const, at: since, agendaItemId: null, text: 'ok', who: null },
    ];
    const c = renderLiveControl(id, { agenda, markers }, m);
    expect(shown(c).description).toContain('▶️ Point en cours : **2. Fête**');
    expect(shown(c).description).toContain('📝 1 note prise en direct');
    expect(labels(c)).toContain('Point suivant : fin de l’ordre du jour');
    const frozen = renderLiveControl(id, { agenda, markers }, m, true);
    expect(frozen.components).toEqual([]);
    expect(shown(frozen)).toMatchObject({ color: 0x99aab5 });
    expect(shown(frozen).description).toContain('▶️ Dernier point : **2. Fête**');
  });

  it('suivi sans ordre du jour : seulement la note', () => {
    const c = renderLiveControl(id, { agenda: [], markers: [] }, m);
    expect(ids(c)).toEqual(['rec.note']);
    expect(shown(c).description).toBe(m.control.noAgenda);
  });

  it('arrêté : qui l’a arrêté et « Reprendre l’enregistrement » ; interrompu : orange, raison', () => {
    const stopped = renderRecordingControl(id, { kind: 'stopped', stoppedBy: 'Pierre Comble', reason: 'arrêt manuel', interrupted: false }, m);
    expect(shown(stopped)).toMatchObject({ title: e.stoppedTitle, description: 'Par **Pierre Comble**.' });
    expect(labels(stopped)).toEqual([m.buttons.resumeRecording]);
    expect(shown(renderRecordingControl(id, { kind: 'stopped', stoppedBy: null, reason: 'vocal vide', interrupted: false }, m)).description).toBe('Vocal vide.');
    const cut = renderRecordingControl(id, { kind: 'stopped', stoppedBy: null, reason: 'déconnexion du vocal', interrupted: true }, m);
    expect(shown(cut)).toMatchObject({ title: e.interruptedTitle, color: 0xe67e22 });
  });

  it('message dépassé (figé) : gris, sans boutons ; la session devient « Enregistrement terminé, de … à … »', () => {
    const frozen = renderRecordingControl(id, rec({ endedAt: new Date('2026-10-15T16:45:00Z') }), m, true);
    expect(frozen.components).toEqual([]);
    expect(shown(frozen)).toMatchObject({ title: e.recordedTitle, description: 'De <t:1792080000:t> à <t:1792082700:t> · lancé par Pierre Comble', color: 0x99aab5 });
  });
});
