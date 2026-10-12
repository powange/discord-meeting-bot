import { describe, expect, it } from 'vitest';
import { agendaItemModal, duplicateModal, meetingModal } from '../src/discord/modals.js';
import { messages } from '../src/i18n/index.js';

// toJSON() applique les mêmes limites que Discord (libellés, descriptions de 100 caractères…) :
// un formulaire invalide ne s'ouvre pas et l'utilisateur ne voit qu'une erreur.
const m = messages('fr');
const zones = ['Europe/Paris', 'America/Argentina/Buenos_Aires'];
const startsAt = new Date('2026-10-15T16:00:00Z');

describe('formulaires', () => {
  it.each(zones)('réunion (création, modification, chaque mode de salon) : valide, fuseau %s', (timezone) => {
    const base = { customId: 'x', heading: m.modal.createTitle, timezone, locale: 'fr', defaultDurationMin: 150, now: new Date('2026-10-12T10:00:00Z') };
    for (const [fixedVoiceChannelId, autoVoice] of [[null, false], ['123', false], [null, true]] as const) {
      for (const reschedulable of [true, false]) {
        const modal = meetingModal(m, { ...base, reschedulable, fixedVoiceChannelId, autoVoice, defaults: { title: 'Point', startsAt, durationMin: 150, voiceChannelId: '42' } });
        expect(() => modal.toJSON()).not.toThrow();
      }
    }
  });

  it.each(zones)('duplication : valide, fuseau %s', (timezone) => {
    expect(() => duplicateModal(m, { customId: 'x', timezone, locale: 'fr', startsAt, durationMin: 150 }).toJSON()).not.toThrow();
  });

  it('point d’ordre du jour : valide', () => {
    expect(() => agendaItemModal(m, 'x', { title: 'Budget', detail: 'Détail' }).toJSON()).not.toThrow();
  });

  it('création en mode « salon créé automatiquement » : pas de choix du salon', () => {
    const modal = meetingModal(m, { customId: 'x', heading: 'h', reschedulable: true, timezone: 'Europe/Paris', locale: 'fr', defaultDurationMin: 60, fixedVoiceChannelId: null, autoVoice: true, defaults: {} });
    expect(modal.toJSON().components.map((c) => ('label' in c ? c.label : ''))).not.toContain(m.modal.voice);
  });
});
