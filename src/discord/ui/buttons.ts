import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, type APIContainerComponent } from 'discord.js';
import { Accent } from './palette.js';

/**
 * Confirmation en deux temps d'une action lourde ou difficile à défaire (même forme partout) :
 * question « ⚠️ … ? », bouton « Confirmer : <verbe> » en rouge, puis « Annuler » en gris (sans emoji :
 * ✖️ est noir, presque invisible en thème sombre).
 */
export function confirmPrompt(question: string, confirm: { id: string; label: string; emoji: string }, cancel: { id: string; label: string }): APIContainerComponent {
  return new ContainerBuilder()
    .setAccentColor(Accent.warning)
    .addTextDisplayComponents((t) => t.setContent(`⚠️ ${question}`))
    .addActionRowComponents((row: ActionRowBuilder<ButtonBuilder>) =>
      row.addComponents(
        new ButtonBuilder().setCustomId(confirm.id).setLabel(confirm.label).setEmoji(confirm.emoji).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(cancel.id).setLabel(cancel.label).setStyle(ButtonStyle.Secondary),
      ),
    )
    .toJSON();
}
