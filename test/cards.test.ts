import { describe, expect, it } from 'vitest';


describe('carte inchangée : pas d’édition', async () => {
  const { sameContent } = await import('../src/services/cards.js');
  it('contenu identique (champs ajoutés par Discord ignorés) ; un changement est vu', () => {
    const next = { embeds: [{ title: 'Bureau', color: 0x5865f2 }], components: [{ type: 1, components: [{ type: 2, custom_id: 'a', label: 'Présent', style: 3 }] }] };
    const current = { embeds: [{ type: 'rich', title: 'Bureau', color: 0x5865f2 }], components: [{ type: 1, id: 1, components: [{ type: 2, id: 2, custom_id: 'a', label: 'Présent', style: 3, disabled: false }] }] };
    expect(sameContent(current, next as never)).toBe(true);
    expect(sameContent(current, { ...next, embeds: [{ title: 'Bureau (modifié)', color: 0x5865f2 }] } as never)).toBe(false);
    const disabled = { ...current, components: [{ type: 1, components: [{ type: 2, custom_id: 'a', label: 'Présent', style: 3, disabled: true }] }] };
    expect(sameContent(disabled, next as never)).toBe(false);
  });
});
