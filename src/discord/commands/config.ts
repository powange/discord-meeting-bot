import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { openConfigPanel } from '../interactions/configPanel.js';
import type { Command } from './types.js';

const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('Configurer le bot de réunions sur ce serveur')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .toJSON();

/** `/config` : une seule commande, qui ouvre un panneau interactif (sections, sélecteurs, boutons). */
export const config: Command = {
  data,
  async execute(ctx, interaction) {
    await openConfigPanel(ctx, interaction);
  },
};
