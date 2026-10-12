import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { messages } from '../../i18n/index.js';
import { UserError } from '../../lib/errors.js';
import { replyEphemeral } from '../interactions/common.js';
import type { Command } from './types.js';

const data = new SlashCommandBuilder()
  .setName('enregistrement')
  .setDescription('Choisir si votre voix peut être enregistrée pendant les réunions')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('refuser').setDescription('Ne plus être enregistré (votre présence reste notée)'))
  .addSubcommand((s) => s.setName('accepter').setDescription('Être de nouveau enregistré'))
  .toJSON();

/** Libre-service du rôle « ne pas m'enregistrer » (RGPD : chacun peut s'opposer à l'enregistrement). */
export const enregistrement: Command = {
  data,
  async execute(ctx, interaction) {
    const settings = await ctx.settings.get(interaction.guildId);
    const m = messages(settings.locale);
    const role = settings.optoutRoleId ? interaction.guild.roles.cache.get(settings.optoutRoleId) : undefined;
    if (!role) throw new UserError(m.errors.optoutNotConfigured);
    if (!role.editable) throw new UserError(m.errors.optoutRoleUnmanageable);

    const refuse = interaction.options.getSubcommand() === 'refuser';
    if (refuse) await interaction.member.roles.add(role, 'Refus de l’enregistrement (/enregistrement refuser)');
    else await interaction.member.roles.remove(role, 'Accord pour l’enregistrement (/enregistrement accepter)');
    await replyEphemeral(interaction, refuse ? m.recording.optoutAdded(role.name) : m.recording.optoutRemoved(role.name));
  },
};
