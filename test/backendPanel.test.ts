import { ComponentType, type APIContainerComponent } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { TranscriptionBackendRow } from '../src/db/schema.js';
import { MAX_BACKENDS, renderBackendPanel } from '../src/discord/embeds/backendPanel.js';
import { decode } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');
const row = (id: number, name: string, extra: Partial<TranscriptionBackendRow> = {}): TranscriptionBackendRow => ({
  id,
  guildId: 'g',
  position: id - 1,
  name,
  type: 'vibe',
  url: `http://${name}:8080`,
  model: 'whisper-1',
  apiKey: null,
  timeoutSec: 600,
  concurrency: 1,
  enabled: true,
  createdAt: new Date(),
  ...extra,
});

/** Tous les composants (Discord en compte au plus 40 par message, conteneur compris). */
function flatten(c: { type: number; components?: unknown[]; accessory?: unknown }): Array<{ type: number; custom_id?: string; disabled?: boolean; label?: string; content?: string }> {
  const children = [...((c.components as never[]) ?? []), ...(c.accessory ? [c.accessory as never] : [])];
  return [c as never, ...children.flatMap((x) => flatten(x))];
}
const buttons = (c: APIContainerComponent) => flatten(c).filter((x) => x.type === ComponentType.Button);
const action = (b: { custom_id?: string }) => {
  const a = decode(b.custom_id!);
  return a?.type === 'tx' ? `${a.action}:${a.backendId ?? '-'}` : '?';
};

describe('renderBackendPanel', () => {
  it('un bloc par serveur : Modifier à côté du nom, puis ses actions', () => {
    const panel = renderBackendPanel([row(1, 'vibe-pc'), row(2, 'speaches', { type: 'openai', model: 'large-v3', apiKey: 'k' })], {}, m);
    expect(buttons(panel).map(action)).toEqual([
      'edit:1', 'up:1', 'toggle:1', 'test:1', 'delete:1',
      'edit:2', 'up:2', 'toggle:2', 'test:2', 'delete:2',
      'add:-', 'testAll:-',
    ]);
    const texts = flatten(panel).filter((x) => x.type === ComponentType.TextDisplay).map((x) => x.content).join('\n');
    expect(texts).toContain('🟢 **2. speaches** · openai');
    expect(texts).toContain('large-v3 · 🔑 clé');
  });

  it('le premier ne peut pas monter', () => {
    const b = buttons(renderBackendPanel([row(1, 'a'), row(2, 'b')], {}, m));
    expect(b.find((x) => action(x) === 'up:1')!.disabled).toBe(true);
    expect(b.find((x) => action(x) === 'up:2')!.disabled).toBe(false);
  });

  it(`${MAX_BACKENDS} serveurs : limite de 40 composants respectée, ajout désactivé`, () => {
    const panel = renderBackendPanel(Array.from({ length: MAX_BACKENDS }, (_, i) => row(i + 1, `srv${i}`)), { notice: 'x' }, m);
    expect(flatten(panel).length).toBeLessThanOrEqual(40);
    expect(buttons(panel).find((x) => action(x) === 'add:-')!.disabled).toBe(true);
  });

  it('suppression : confirmation à la place des actions du serveur', () => {
    const panel = renderBackendPanel([row(1, 'a'), row(2, 'b')], { confirmDeleteId: 2 }, m);
    expect(buttons(panel).map(action)).toEqual(['edit:1', 'up:1', 'toggle:1', 'test:1', 'delete:1', 'edit:2', 'confirmDelete:2', 'select:-', 'add:-', 'testAll:-']);
  });

  it('désactivé : ⚪ et bouton Activer ; résultat de test sous le serveur', () => {
    const panel = renderBackendPanel([row(1, 'a', { enabled: false })], { notices: new Map([[1, '✅ Opérationnel']]) }, m);
    const texts = flatten(panel).filter((x) => x.type === ComponentType.TextDisplay).map((x) => x.content).join('\n');
    expect(texts).toContain('⚪ **1. a**');
    expect(texts).toContain('✅ Opérationnel');
    expect(buttons(panel).find((x) => action(x) === 'toggle:1')!.label).toBe('Activer');
    expect(buttons(panel).some((x) => action(x) === 'testAll:-')).toBe(false); // aucun serveur actif
  });

  it('aucun serveur : serveurs du YAML affichés, test possible', () => {
    const panel = renderBackendPanel([], { yamlFallback: [{ name: 'yaml-vibe', type: 'vibe', url: 'http://y:8080' }] }, m);
    const texts = flatten(panel).filter((x) => x.type === ComponentType.TextDisplay).map((x) => x.content).join('\n');
    expect(texts).toContain('yaml-vibe');
    expect(buttons(panel).map(action)).toEqual(['add:-', 'testAll:-']);
  });
});
