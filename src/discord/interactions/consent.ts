import { MessageFlags, type ButtonInteraction } from 'discord.js';
import type { AppContext } from '../../context.js';
import { UserError } from '../../lib/errors.js';
import { renderConsent } from '../embeds/meetingManager.js';

/**
 * Choix personnel d'enregistrement, ouvert par le bouton « Mon choix d'enregistrement » (post
 * épinglé, avertissements) : prend ou rend le rôle « ne pas m'enregistrer ». Ouvert à tous.
 */
export async function handleConsent(ctx: AppContext, interaction: ButtonInteraction<'cached'>, verb: 'open' | 'refuse' | 'accept'): Promise<void> {
  const settings = await ctx.settings.get(interaction.guildId);
  const m = await ctx.settings.messages(interaction.guildId);
  const role = settings.optoutRoleId ? interaction.guild.roles.cache.get(settings.optoutRoleId) : undefined;
  const refused = () => Boolean(role && interaction.member.roles.cache.has(role.id));

  if (verb === 'open' || !role) {
    await interaction.reply({
      components: [renderConsent({ roleConfigured: Boolean(role), refused: refused() }, m)],
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    });
    return;
  }
  if (!role.editable) throw new UserError(m.errors.optoutRoleUnmanageable);
  if (verb === 'refuse') await interaction.member.roles.add(role, 'Refus de l’enregistrement');
  else await interaction.member.roles.remove(role, 'Accord pour l’enregistrement');
  await interaction.update({
    components: [renderConsent({ roleConfigured: true, refused: verb === 'refuse', notice: verb === 'refuse' ? m.consent.refused : m.consent.accepted }, m)],
  });
}
