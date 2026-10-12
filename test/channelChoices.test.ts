import { describe, expect, it } from 'vitest';
import { channelLabel, channelPage, pageOf, PAGE_SIZE, type ChannelInfo } from '../src/domain/channelChoices.js';

const cat = (name: string, position: number) => ({ name, position });
const ch = (id: string, name: string, position: number, category: ChannelInfo['category']): ChannelInfo => ({ id, name, position, category });

describe('choix de salon', () => {
  const channels = [
    ch('3', 'commands', 0, cat('Admin', 2)),
    ch('1', 'commands', 0, cat('Général', 0)),
    ch('2', 'commands', 1, cat('Jeux', 1)),
    ch('0', 'rules', 0, null),
  ];

  it('homonymes distingués par leur catégorie, ordre du serveur (hors catégorie en premier)', () => {
    expect(channelPage(channels, 0).options).toEqual([
      { label: '#rules', value: '0' },
      { label: 'Général › #commands', value: '1' },
      { label: 'Jeux › #commands', value: '2' },
      { label: 'Admin › #commands', value: '3' },
    ]);
  });

  it('pagination par 25, page bornée', () => {
    const many = Array.from({ length: 60 }, (_, i) => ch(String(i), `salon-${i}`, i, cat('C', 0)));
    expect(channelPage(many, 0).options).toHaveLength(PAGE_SIZE);
    expect(channelPage(many, 2)).toMatchObject({ page: 2, pages: 3 });
    expect(channelPage(many, 2).options).toHaveLength(10);
    expect(channelPage(many, 9).page).toBe(2);
    expect(pageOf(many, '30')).toBe(1);
  });

  it('libellé tronqué à 100 caractères', () => {
    expect(channelLabel(ch('x', 'n'.repeat(120), 0, cat('Cat', 0))).length).toBe(100);
  });
});
