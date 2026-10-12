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
