import { describe, expect, it } from 'vitest';
import { formatWhen } from '../src/domain/time.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');

describe('textes lisibles en notification', () => {
  it('date lisible dans le fuseau du serveur', () => {
    expect(formatWhen(new Date('2026-10-12T16:00:00Z'), 'Europe/Paris', 'fr', m.format.when)).toBe('lundi 12/10 à 18h00');
  });

  it.each([
    [0, 'maintenant'],
    [15, 'dans 15 min'],
    [89, 'dans 89 min'],
    [120, 'dans 2 h'],
    [1440, 'dans 24 h'],
    [2880, 'dans 2 jours'],
  ])('startsIn(%i) = %s', (min, expected) => {
    expect(m.format.startsIn(min)).toBe(expected);
  });

  it('aucune syntaxe Discord brute dans les messages qui notifient', () => {
    const texts = [
      m.thread.reminder('Bureau', 'dans 15 min', 'lundi 12/10 à 18h00', 'Salle de réunion'),
      m.thread.started('Bureau', 'Salle de réunion'),
      m.thread.rescheduled('Bureau', 'lundi 19/10 à 18h00', 'dans 7 jours'),
      m.thread.cancelled('Bureau', 'Pierre', 'Imprévu'),
      m.thread.ended('Pierre'),
    ];
    for (const text of texts) expect(text).not.toMatch(/<[@#:t]|\*\*/);
  });
});

describe('avertissement d’enregistrement', () => {
  it('signalé par ⚠️, qui l’a lancé, et la façon de refuser en petit texte', () => {
    expect(m.recording.announce('Pierre Comble')).toBe(
      "⚠️ **Cette réunion est enregistrée** · lancé par Pierre Comble\nUne piste audio par participant, uniquement pour rédiger le compte rendu.\n-# Vous ne voulez pas être enregistré ? Bouton « Mon choix d'enregistrement » : votre présence reste notée, pas votre voix.",
    );
    expect(m.recording.announce(null)).toContain('· démarrage automatique');
    expect(m.recording.stopped('Pierre Comble', m.recording.reasons.manual!)).toBe('⏹️ **Enregistrement arrêté** · par Pierre Comble');
    expect(m.recording.stopped(null, m.recording.reasons.empty!)).toBe('⏹️ **Enregistrement arrêté** · vocal vide');
    expect(m.recording.arrival('42')).toMatch(/^⚠️ <@42>, cette réunion est \*\*enregistrée\*\*/);
  });
});

describe('mentionBatches', () => {
  it('texte lisible en tête, mentions autorisées uniquement pour les personnes visées', async () => {
    const { mentionBatches } = await import('../src/discord/notify.js');
    const [batch] = mentionBatches('« <@999> » commence\nInscrits : ', ['111', '222']);
    expect(batch!.content).toBe('« <@999> » commence\nInscrits : <@111> <@222>');
    expect(batch!.users).toEqual(['111', '222']);
  });
  it('sans personne à mentionner : texte seul', async () => {
    const { mentionBatches } = await import('../src/discord/notify.js');
    expect(mentionBatches('Texte\nInscrits : ', [])).toEqual([{ content: 'Texte\nInscrits :', users: [] }]);
  });
});
