import { ComponentType, type APIContainerComponent } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { renderHub } from '../src/discord/embeds/hub.js';
import { renderConsent, renderMeetingManager } from '../src/discord/embeds/meetingManager.js';
import { decode } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');
const id = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
const meeting = { id, title: 'Bureau', status: 'scheduled' as const, autoRecord: false };

function actions(c: APIContainerComponent): string[] {
  const out: string[] = [];
  const walk = (x: { type: number; custom_id?: string; components?: unknown[] }) => {
    if (x.type === ComponentType.Button && x.custom_id) {
      const a = decode(x.custom_id);
      out.push(a ? a.type : '?');
    }
    for (const y of (x.components as never[]) ?? []) walk(y);
  };
  walk(c as never);
  return out;
}

describe('panneau « Gérer »', () => {
  it('réunion à venir : toutes les actions, sans régénération tant que rien n’est enregistré', () => {
    expect(actions(renderMeetingManager(meeting, { hasRecording: false }, m))).toEqual([
      'meeting.edit',
      'meeting.duplicate',
      'meeting.autoRecord',
      'rec.start',
      'meeting.end',
      'meeting.cancel',
      'meeting.everyone', // + sélecteur des rôles invités
    ]);
  });
  it('enregistrement : Enregistrer maintenant, ou Arrêter s’il tourne', () => {
    expect(actions(renderMeetingManager(meeting, { hasRecording: true, recording: true }, m))).toContain('rec.stop');
    expect(actions(renderMeetingManager(meeting, { hasRecording: true, recording: true }, m))).not.toContain('rec.start');
  });
  it('tout retranscrire : confirmation demandée', () => {
    const view = actions(renderMeetingManager({ ...meeting, status: 'ended' }, { hasRecording: true, confirmRegenAll: true }, m));
    expect(view).toContain('meeting.regenAllConfirm');
    expect(view).not.toContain('meeting.regenAll');
  });
  it('clôture : confirmation demandée', () => {
    expect(actions(renderMeetingManager(meeting, { hasRecording: false, confirmEnd: true }, m))).toContain('meeting.endConfirm');
  });
  it('réunion close et enregistrée : dupliquer et régénérer seulement', () => {
    expect(actions(renderMeetingManager({ ...meeting, status: 'ended' }, { hasRecording: true }, m))).toEqual(['meeting.duplicate', 'meeting.regen', 'meeting.regenAll']);
  });
});

describe('choix d’enregistrement', () => {
  it('accepte : bouton Refuser actif', () => {
    const c = renderConsent({ refused: false }, m);
    expect(actions(c)).toEqual(['consent.refuse', 'consent.accept']);
    expect(JSON.stringify(c)).toContain('**acceptez**');
  });
  it('refuse : statut affiché, bouton Accepter actif', () => {
    const c = renderConsent({ refused: true, notice: m.consent.refused }, m);
    expect(JSON.stringify(c)).toContain('**refusez**');
    expect(JSON.stringify(c)).toContain('vous ne serez plus enregistré');
  });
  it('accessible depuis le post épinglé', () => {
    const hub = renderHub([], m);
    expect(hub.components[0]!.components.map((b) => decode((b as { custom_id: string }).custom_id)?.type)).toEqual(['meeting.create', 'poll.create', 'consent.open']);
  });
});
