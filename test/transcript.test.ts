import { describe, expect, it } from 'vitest';
import { buildBlocks, chunkLines, cleanSegments, formatLine, mergeTranscript } from '../src/domain/transcript.js';

const seg = (id: number, userId: string, startMs: number, endMs: number) => ({ id, userId, startMs, endMs });

describe('buildBlocks', () => {
  it('regroupe les prises de parole proches d’une même personne', () => {
    const blocks = buildBlocks([seg(1, 'a', 0, 2000), seg(2, 'a', 4000, 6000), seg(3, 'b', 1000, 3000), seg(4, 'a', 20_000, 21_000)], 4000, 300_000);
    expect(blocks.map((b) => [b.userId, b.startMs, b.endMs, b.segments.map((s) => s.id)])).toEqual([
      ['a', 0, 6000, [1, 2]],
      ['b', 1000, 3000, [3]],
      ['a', 20_000, 21_000, [4]], // pause trop longue : nouveau bloc
    ]);
  });
  it('coupe un bloc trop long', () => {
    const segs = Array.from({ length: 10 }, (_, i) => seg(i, 'a', i * 60_000, i * 60_000 + 58_000));
    const blocks = buildBlocks(segs, 4000, 5 * 60_000);
    expect(blocks.every((b) => b.endMs - b.startMs <= 5 * 60_000)).toBe(true);
    expect(blocks.flatMap((b) => b.segments).length).toBe(10);
  });
});

describe('cleanSegments', () => {
  it('retire les hallucinations, le vide et le non-parlé', () => {
    const out = cleanSegments([
      { start: 0, end: 1, text: '  Bonjour   à tous ' },
      { start: 1, end: 2, text: "Sous-titres réalisés par la communauté d'Amara.org" },
      { start: 2, end: 3, text: 'Merci d’avoir regardé !' },
      { start: 3, end: 4, text: '...' },
      { start: 4, end: 5, text: 'On passe au budget', noSpeechProb: 0.95 },
      { start: 5, end: 6, text: 'Merci.' }, // court mais plausible : conservé
    ]);
    expect(out.map((s) => s.text)).toEqual(['Bonjour à tous', 'Merci.']);
  });
});

describe('transcription fusionnée', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 16, 0, s));
  const lines = [
    { userId: 'b', name: 'Bob', startAt: at(5), text: 'Oui.' },
    { userId: 'a', name: 'Alice', startAt: at(0), text: 'Bonjour.' },
    { userId: 'a', name: 'Alice', startAt: at(2), text: 'On commence ?' },
    { userId: 'a', name: 'Alice', startAt: at(40), text: 'Point suivant.' },
  ];
  it('ordre chronologique, répliques successives regroupées', () => {
    expect(mergeTranscript(lines).map((l) => `${l.name}: ${l.text}`)).toEqual(['Alice: Bonjour. On commence ?', 'Bob: Oui.', 'Alice: Point suivant.']);
  });
  it('ligne horodatée dans le fuseau du serveur', () => {
    expect(formatLine(lines[1]!, 'Europe/Paris')).toBe('[18:00:00] Alice : Bonjour.');
  });
});

describe('chunkLines', () => {
  it('ne coupe jamais une réplique et respecte la taille', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `[18:00:${String(i).padStart(2, '0')}] X : ${'mot '.repeat(40)}`);
    const chunks = chunkLines(lines, 500);
    expect(chunks.flat()).toEqual(lines);
    expect(chunks.length).toBeGreaterThan(1);
  });
  it('une seule réplique plus grosse que la limite forme son propre morceau', () => {
    expect(chunkLines(['x'.repeat(10_000), 'y'], 100)).toEqual([['x'.repeat(10_000)], ['y']]);
  });
});
