import { MessageFlags, type ButtonInteraction } from 'discord.js';
import type { AppContext } from '../../context.js';
import { renderConsent } from '../embeds/meetingManager.js';

/**
 * Choix personnel d'enregistrement, ouvert par le bouton « Mon choix d'enregistrement » (post
 * épinglé, avertissements). Ouvert à tous ; le choix est gardé en base, invisible des autres.
 */
export async function handleConsent(ctx: AppContext, interaction: ButtonInteraction<'cached'>, verb: 'open' | 'refuse' | 'accept'): Promise<void> {
  const m = await ctx.settings.messages(interaction.guildId);
  if (verb === 'open') {
    const refused = (await ctx.optouts.list(interaction.guildId)).includes(interaction.user.id);
    await interaction.reply({ components: [renderConsent({ refused }, m)], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
    return;
  }
  const refused = verb === 'refuse';
  await ctx.optouts.set(interaction.guildId, interaction.user.id, refused);
  await interaction.update({ components: [renderConsent({ refused, notice: refused ? m.consent.refused : m.consent.accepted }, m)] });
}
