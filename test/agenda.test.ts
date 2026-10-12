import { describe, expect, it } from 'vitest';
import { AGENDA_MAX_ITEMS, checkAddItem, moveItem, reindex, sortAgenda } from '../src/domain/agenda.js';

const base = { title: 'Budget', detail: '', count: 0, locked: false, meetingOpen: true, actorIsManager: false };

describe('checkAddItem', () => {
  it('accepte et normalise', () => {
    expect(checkAddItem({ ...base, title: '  Budget 2027  ', detail: ' détails \n' })).toEqual({ ok: true, title: 'Budget 2027', detail: 'détails' });
  });
  it('tronque les champs trop longs', () => {
    const r = checkAddItem({ ...base, title: 'x'.repeat(300), detail: 'y'.repeat(5000) });
    expect(r.ok && [r.title.length, r.detail.length]).toEqual([100, 1000]);
  });
  it('refuse un titre vide', () => {
    expect(checkAddItem({ ...base, title: '   ' })).toEqual({ ok: false, error: 'empty' });
  });
  it('verrou : refusé aux membres, permis aux gestionnaires', () => {
    expect(checkAddItem({ ...base, locked: true })).toEqual({ ok: false, error: 'locked' });
    expect(checkAddItem({ ...base, locked: true, actorIsManager: true }).ok).toBe(true);
  });
  it('limite de taille', () => {
    expect(checkAddItem({ ...base, count: AGENDA_MAX_ITEMS })).toEqual({ ok: false, error: 'full' });
    expect(checkAddItem({ ...base, count: AGENDA_MAX_ITEMS - 1 }).ok).toBe(true);
  });
  it('réunion close', () => {
    expect(checkAddItem({ ...base, meetingOpen: false, actorIsManager: true })).toEqual({ ok: false, error: 'closed' });
  });
});

describe('moveItem', () => {
  it('monte et descend', () => {
    expect(moveItem([1, 2, 3], 2, 'up')).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 2, 'down')).toEqual([1, 3, 2]);
  });
  it('impossible aux extrémités ou pour un id inconnu', () => {
    expect(moveItem([1, 2, 3], 1, 'up')).toBeNull();
    expect(moveItem([1, 2, 3], 3, 'down')).toBeNull();
    expect(moveItem([1, 2, 3], 9, 'up')).toBeNull();
  });
  it('ne modifie pas la liste source', () => {
    const ids = [1, 2, 3];
    moveItem(ids, 3, 'up');
    expect(ids).toEqual([1, 2, 3]);
  });
});

describe('reindex / sortAgenda', () => {
  it('positions compactes', () => {
    expect(reindex([5, 2, 9])).toEqual([
      { id: 5, position: 0 },
      { id: 2, position: 1 },
      { id: 9, position: 2 },
    ]);
  });
  it('trie par position puis id', () => {
    const items = [
      { id: 3, position: 1 },
      { id: 2, position: 0 },
      { id: 1, position: 1 },
    ];
    expect(sortAgenda(items).map((i) => i.id)).toEqual([2, 1, 3]);
  });
});
