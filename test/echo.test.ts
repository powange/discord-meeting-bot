import { describe, expect, it } from 'vitest';
import { dropEchoes, textContainment } from '../src/domain/transcript.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 16, 0, 0) + s * 1000);
const line = (userId: string, start: number, end: number, text: string) => ({ userId, startAt: at(start), endAt: at(end), text });

describe('dropEchoes', () => {
  it('même phrase captée par le micro voisin au même moment : on garde l’originale', () => {
    const out = dropEchoes([
      line('alice', 10, 14, 'On valide le budget pour la fête de décembre.'),
      line('bob', 10.3, 14.2, 'on valide le budget pour la fête de décembre'),
    ]);
    expect(out.map((l) => l.userId)).toEqual(['alice']);
  });

  it('écho partiel (une partie de la phrase seulement)', () => {
    const out = dropEchoes([line('alice', 10, 16, 'Je propose que Marie réserve la salle avant vendredi soir.'), line('bob', 11, 13, 'Marie réserve la salle avant vendredi')]);
    expect(out.map((l) => l.userId)).toEqual(['alice']);
  });

  it.each([
    ['même phrase dite à 30 s d’intervalle', [line('alice', 10, 13, 'Est-ce que tout le monde est d’accord ?'), line('bob', 43, 46, 'Est-ce que tout le monde est d’accord ?')]],
    ['phrases différentes en même temps', [line('alice', 10, 13, 'Je pense que la date convient très bien.'), line('bob', 11, 14, 'Il faudra prévenir le trésorier aussi.')]],
    ['réponses courtes simultanées', [line('alice', 10, 10.5, 'Oui.'), line('bob', 10.1, 10.6, 'Oui.')]],
    ['même personne', [line('alice', 10, 13, 'On valide le budget pour la fête.'), line('alice', 13, 16, 'On valide le budget pour la fête.')]],
  ])('conservé : %s', (_label, lines) => {
    expect(dropEchoes(lines)).toHaveLength(2);
  });

  it('similarité de textes', () => {
    expect(textContainment('Bonjour à tous', 'bonjour a tous !')).toBe(1);
    expect(textContainment('Bonjour à tous', 'Au revoir')).toBeLessThan(0.3);
  });
});
