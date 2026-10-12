import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { DateTime } from 'luxon';
import { canCreateMeeting } from '../../domain/permissions.js';
import { messages } from '../../i18n/index.js';
import { UserError } from '../../lib/errors.js';
import { meetingScopeFromChannel, replyEphemeral, requireManager } from '../interactions/common.js';
import { showCreateModal, showEditModal } from '../interactions/components.js';
import { parseWhen } from '../modals.js';
import type { Command } from './types.js';

const data = new SlashCommandBuilder()
  .setName('reunion')
  .setDescription('Gérer les réunions')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('creer')
      .setDescription('Planifier une nouvelle réunion')
      .addStringOption((o) =>
        o.setName('quand').setDescription('Optionnel, pour une date lointaine : ex. 15/01/2027 18:30').setMaxLength(40),
      ),
  )
  .addSubcommand((s) => s.setName('modifier').setDescription('Modifier la réunion de ce post'))
  .addSubcommand((s) =>
    s
      .setName('annuler')
      .setDescription('Annuler la réunion de ce post')
      .addStringOption((o) => o.setName('raison').setDescription('Raison affichée dans le post').setMaxLength(500)),
  )
  .addSubcommand((s) => s.setName('terminer').setDescription('Clore la réunion de ce post'))
  .addSubcommand((s) =>
    s
      .setName('dupliquer')
      .setDescription('Créer une nouvelle réunion identique à une autre date')
      .addStringOption((o) => o.setName('quand').setDescription('Date et heure, ex. 22/10/2026 18:30').setRequired(true).setMaxLength(40))
      .addBooleanOption((o) => o.setName('odj').setDescription("Reprendre l'ordre du jour (défaut : non)")),
  )
  .toJSON();

export const reunion: Command = {
  data,
  async execute(ctx, interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'creer') {
      const when = interaction.options.getString('quand');
      let startsAt: Date | undefined;
      if (when) {
        const settings = await ctx.settings.get(interaction.guildId);
        const m = messages(settings.locale);
        startsAt = parseWhen(when, settings.timezone, m, DateTime.now());
        if (startsAt.getTime() <= Date.now()) throw new UserError(m.errors.datePast);
      }
      await showCreateModal(ctx, interaction, startsAt);
      return;
    }

    const scope = await meetingScopeFromChannel(ctx, interaction);
    const { meeting, m } = scope;

    switch (sub) {
      case 'modifier':
        await showEditModal(interaction, scope);
        return;

      case 'annuler': {
        requireManager(scope);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const ok = await ctx.meetings.cancel(meeting.id, interaction.user.id, interaction.options.getString('raison'));
        await replyEphemeral(interaction, ok ? m.replies.cancelled : m.errors.meetingClosed);
        return;
      }

      case 'terminer': {
        requireManager(scope);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const ok = await ctx.meetings.end(meeting.id, interaction.user.id);
        await replyEphemeral(interaction, ok ? m.replies.ended : m.errors.meetingClosed);
        return;
      }

      case 'dupliquer': {
        if (!canCreateMeeting(scope.actor, scope.settings)) throw new UserError(m.errors.cannotCreate);
        const startsAt = parseWhen(interaction.options.getString('quand', true), scope.settings.timezone, m, DateTime.now());
        if (startsAt.getTime() <= Date.now()) throw new UserError(m.errors.datePast);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const copy = await ctx.meetings.create(
          interaction.guild,
          interaction.user.id,
          {
            title: meeting.title,
            description: meeting.description,
            startsAt,
            durationMin: meeting.durationMin,
            voiceChannelId: meeting.voiceChannelId,
          },
          interaction.options.getBoolean('odj') ? { copyAgendaFrom: meeting.id } : {},
        );
        await replyEphemeral(interaction, m.replies.duplicated(copy.threadId!));
        return;
      }
    }
  },
};
