import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorSpacingSize, type APIContainerComponent } from 'discord.js';
import type { TranscriptionBackendRow } from '../../db/schema.js';
import { encode, type TxAction } from '../../domain/customId.js';
import type { Messages } from '../../i18n/index.js';
import { truncate } from '../../lib/text.js';

/**
 * Nombre maximal de serveurs : chaque serveur occupe 8 composants (bloc, texte, bouton
 * Modifier, rangée de 4 boutons) et Discord limite un message à 40 composants, conteneur
 * compris (4 serveurs + en-tête + boutons généraux et retour = 39).
 */
export const MAX_BACKENDS = 4;

export interface PanelState {
  /** Résultat ou confirmation à afficher sous un serveur (test, modification…). */
  notices?: ReadonlyMap<number, string>;
  /** Message général en bas du panneau. */
  notice?: string | undefined;
  /** Serveur dont la suppression attend confirmation. */
  confirmDeleteId?: number | null;
  /** Serveurs du YAML, affichés tant qu'aucun serveur n'est géré depuis Discord. */
  yamlFallback?: ReadonlyArray<{ name: string; type: string; url: string }>;
  /** Faux pour un administrateur qui n'est pas propriétaire du bot : consultation et tests seulement. */
  canEdit?: boolean;
}

const tx = (action: TxAction, backendId: number | null = null) => encode({ type: 'tx', action, backendId });
const button = (action: TxAction, id: number | null, emoji: string, label: string, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(tx(action, id)).setEmoji(emoji).setLabel(label).setStyle(style);

/** Panneau des serveurs de transcription : un bloc par serveur avec ses boutons d'action. */
export function renderBackendPanel(rows: readonly TranscriptionBackendRow[], state: PanelState, m: Messages): APIContainerComponent {
  const p = m.backendPanel;
  const canEdit = state.canEdit ?? true;
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents((t) =>
      t.setContent(`## ${p.title}\n-# ${p.footer}${canEdit ? '' : `\n-# 🔒 ${p.readOnly}`}${state.notice ? `\n\n${state.notice}` : ''}`),
    );

  if (rows.length === 0) {
    const fallback = state.yamlFallback ?? [];
    container.addTextDisplayComponents((t) =>
      t.setContent(fallback.length ? [p.fromYaml, ...fallback.map((b, i) => `🟢 **${i + 1}. ${b.name}** · ${b.type} · \`${b.url}\``)].join('\n') : p.empty),
    );
  }

  rows.forEach((r, i) => {
    const notice = state.notices?.get(r.id);
    const text = [
      `${r.enabled ? '🟢' : '⚪'} **${i + 1}. ${truncate(r.name, 40)}** · ${r.type}${r.enabled ? '' : ` · *${p.disabled}*`}`,
      `-# \`${truncate(r.url, 120)}\`${r.type === 'openai' ? ` · ${truncate(r.model, 60)}` : ''}${r.apiKey ? ` · ${p.withKey}` : ''}`,
      ...(notice ? [notice] : []),
    ].join('\n');
    container.addSectionComponents((s) =>
      s
        .addTextDisplayComponents((t) => t.setContent(text))
        .setButtonAccessory(canEdit ? button('edit', r.id, '✏️', p.edit, ButtonStyle.Primary) : button('test', r.id, '🧪', p.test)),
    );

    if (!canEdit) {
      // Consultation : le test est dans l'accessoire, pas de rangée d'actions.
    } else if (state.confirmDeleteId === r.id) {
      container.addActionRowComponents((row: ActionRowBuilder<ButtonBuilder>) =>
        row.addComponents(button('confirmDelete', r.id, '🗑️', p.confirmDelete(truncate(r.name, 40)), ButtonStyle.Danger), button('select', null, '↩️', p.cancel)),
      );
    } else {
      container.addActionRowComponents((row: ActionRowBuilder<ButtonBuilder>) =>
        row.addComponents(
          // « Monter » seulement : descendre un serveur = monter celui du dessous (limite de composants).
          button('up', r.id, '⬆️', p.up).setDisabled(i === 0),
          button('toggle', r.id, r.enabled ? '⏸️' : '▶️', r.enabled ? p.disable : p.enable),
          button('test', r.id, '🧪', p.test),
          button('delete', r.id, '🗑️', p.delete, ButtonStyle.Danger),
        ),
      );
    }
  });

  container.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Large));
  const canTestAll = rows.some((r) => r.enabled) || (rows.length === 0 && Boolean(state.yamlFallback?.length));
  container.addActionRowComponents((row: ActionRowBuilder<ButtonBuilder>) => {
    if (canEdit) row.addComponents(button('add', null, '➕', p.add, ButtonStyle.Success).setDisabled(rows.length >= MAX_BACKENDS));
    if (canTestAll) row.addComponents(button('testAll', null, '🧪', p.testAll));
    // Retour à l'accueil du panneau /config.
    row.addComponents(new ButtonBuilder().setCustomId(encode({ type: 'cfg', action: 'home' })).setEmoji('↩️').setLabel(m.config.back).setStyle(ButtonStyle.Secondary));
    return row;
  });
  return container.toJSON();
}
