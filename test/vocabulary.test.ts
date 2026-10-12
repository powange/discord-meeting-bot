import { describe, expect, it } from 'vitest';
import { correctionTerms, parseVocabulary, PROMPT_MAX, whisperPrompt } from '../src/domain/vocabulary.js';

describe('vocabulaire du serveur', () => {
  it('virgules, points-virgules ou retours à la ligne ; doublons et vides retirés', () => {
    expect(parseVocabulary('Pol, Apothicaire ;\n\nLiteLLM, pol ,  Carnets   de l’Apothicaire ')).toEqual(['Pol', 'Apothicaire', 'LiteLLM', 'Carnets de l’Apothicaire']);
  });
});

describe('termes tirés des consignes de correction', () => {
  it('garde le bon terme, jamais celui qui suit une négation', () => {
    expect(correctionTerms(['Pol et non Paul'])).toEqual(['Pol']);
    expect(correctionTerms(['Il faut écrire Kévin, pas Kevin'])).toEqual(['Kévin']);
    expect(correctionTerms(['Apothicaire au lieu de Apoticaire'])).toEqual(['Apothicaire']);
  });

  it('termes entre guillemets ; mots courants en début de phrase ignorés', () => {
    expect(correctionTerms(['La série s’appelle « Les Carnets de l’Apothicaire »'])).toEqual(['Les Carnets de l’Apothicaire', 'Carnets', 'Apothicaire']);
    expect(correctionTerms(['La décision était de reporter à janvier'])).toEqual([]);
  });
});

describe('prompt Whisper', () => {
  it('ordre de priorité : YAML, vocabulaire, corrections, participants, ODJ ; sans doublon', () => {
    const prompt = whisperPrompt({ base: 'Réunion associative.', vocabulary: ['LiteLLM'], corrections: ['Pol et non Paul'], names: ['Emma', 'Pol'], agenda: ['Budget'] });
    expect(prompt).toBe('Réunion associative. LiteLLM, Pol, Emma, Budget');
  });

  it('coupé entre deux termes sous la limite ; rien → undefined', () => {
    const prompt = whisperPrompt({ vocabulary: Array.from({ length: 100 }, (_, i) => `terme-numero-${i}`), corrections: [], names: [], agenda: [] })!;
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX);
    expect(prompt.endsWith(',')).toBe(false);
    expect(prompt.split(', ').every((t) => /^terme-numero-\d+$/.test(t))).toBe(true);
    expect(whisperPrompt({ vocabulary: [], corrections: [], names: [], agenda: [] })).toBeUndefined();
  });
});
