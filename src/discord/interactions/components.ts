import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { AppContext } from '../../context.js';
import { checkAddItem, moveItem } from '../../domain/agenda.js';
import { encode, type Action } from '../../domain/customId.js';
import { canReschedule, isOpen } from '../../domain/meeting.js';
import { UserError } from '../../lib/errors.js';
import { renderAgendaManager } from '../embeds/meetingCard.js';
import { agendaItemModal, meetingModal, readAgendaItemModal, readMeetingModal } from '../modals.js';
import { meetingScope, replyEphemeral, requireManager, type MeetingScope } from './common.js';

type ComponentInteraction = ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'> | ModalSubmitInteraction<'cached'>;

/** Traite un bouton, menu ou formulaire dont le customId a été décodé. */
export async function handleAction(ctx: AppContext, interaction: ComponentInteraction, action: Action): Promise<void> {
  if (action.type === 'meeting.createSubmit') {
    if (!interaction.isModalSubmit()) return;
    return createSubmit(ctx, interaction);
  }

  const scope = await meetingScope(ctx, interaction, action.meetingId);
  const { meeting, m } = scope;

  switch (action.type) {
    case 'rsvp': {
      if (!interaction.isButton()) return;
      if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
      await ctx.repos.setRsvp(meeting.id, interaction.user.id, action.status);
      await interaction.deferUpdate();
      ctx.cards.refresh(meeting.id);
      return;
    }

    case 'agenda.add': {
      if (!interaction.isButton()) return;
      if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
      if (meeting.agendaLocked && !scope.canManage) throw new UserError(m.errors.agendaLocked);
      await interaction.showModal(agendaItemModal(m, encode({ type: 'agenda.addSubmit', meetingId: meeting.id })));
      return;
    }

    case 'agenda.addSubmit': {
      if (!interaction.isModalSubmit()) return;
      const input = readAgendaItemModal(interaction);
      const item = await ctx.repos.addAgendaItem(meeting.id, interaction.user.id, (count, locked) => {
        const check = checkAddItem({ ...input, count, locked, meetingOpen: isOpen(meeting.status), actorIsManager: scope.canManage });
        if (!check.ok) throw new UserError(agendaError(scope, check.error));
        return { title: check.title, detail: check.detail };
      });
      ctx.cards.refresh(meeting.id);
      await replyEphemeral(interaction, m.replies.itemAdded(item.title));
      return;
    }

    case 'agenda.manage': {
      requireManager(scope);
      if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
      const agenda = await ctx.repos.listAgenda(meeting.id);
      await interaction.reply({ ...renderAgendaManager(meeting, agenda, null, m), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }

    case 'agenda.select': {
      if (!interaction.isStringSelectMenu()) return;
      requireManager(scope);
      const selected = Number(interaction.values[0]);
      await updateManager(ctx, interaction, scope, Number.isInteger(selected) ? selected : null);
      return;
    }

    case 'agenda.move':
    case 'agenda.remove': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
      const ids = (await ctx.repos.listAgenda(meeting.id)).map((i) => i.id);
      if (!ids.includes(action.itemId)) throw new UserError(m.errors.agendaItemGone);
      if (action.type === 'agenda.move') {
        const next = moveItem(ids, action.itemId, action.direction);
        if (next) await ctx.repos.reorderAgenda(meeting.id, next);
        await updateManager(ctx, interaction, scope, action.itemId);
      } else {
        await ctx.repos.reorderAgenda(
          meeting.id,
          ids.filter((id) => id !== action.itemId),
        );
        await updateManager(ctx, interaction, scope, null);
      }
      ctx.cards.refresh(meeting.id);
      return;
    }

    case 'agenda.lock': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      const updated = await ctx.repos.updateMeeting(meeting.id, { agendaLocked: action.locked });
      await updateManager(ctx, interaction, { ...scope, meeting: updated ?? meeting }, null);
      ctx.cards.refresh(meeting.id);
      return;
    }

    case 'meeting.edit': {
      if (!interaction.isButton()) return;
      await showEditModal(interaction, scope);
      return;
    }

    case 'meeting.editSubmit': {
      if (!interaction.isModalSubmit()) return;
      requireManager(scope);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const input = readMeetingModal(interaction, m, {
        timezone: scope.settings.timezone,
        reschedulable: canReschedule(meeting.status),
        current: meeting,
      });
      await ctx.meetings.update(interaction.guild, meeting, input, interaction.user.id);
      await replyEphemeral(interaction, m.replies.updated);
      return;
    }
  }
}

/** Ouvre le formulaire de modification (bouton « Modifier » ou `/reunion modifier`). */
export async function showEditModal(interaction: ButtonInteraction<'cached'> | ChatInputCommandInteraction<'cached'>, scope: MeetingScope): Promise<void> {
  requireManager(scope);
  const { meeting, m } = scope;
  if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
  await interaction.showModal(
    meetingModal(m, {
      customId: encode({ type: 'meeting.editSubmit', meetingId: meeting.id }),
      heading: m.modal.editTitle,
      reschedulable: canReschedule(meeting.status),
      timezone: scope.settings.timezone,
      defaults: meeting,
    }),
  );
}

async function createSubmit(ctx: AppContext, interaction: ModalSubmitInteraction<'cached'>): Promise<void> {
  const settings = await ctx.settings.get(interaction.guildId);
  const m = await ctx.settings.messages(interaction.guildId);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const input = readMeetingModal(interaction, m, { timezone: settings.timezone, reschedulable: true });
  const meeting = await ctx.meetings.create(interaction.guild, interaction.user.id, input);
  await replyEphemeral(interaction, m.replies.created(meeting.threadId!));
}

async function updateManager(
  ctx: AppContext,
  interaction: ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>,
  scope: MeetingScope,
  selectedId: number | null,
): Promise<void> {
  const agenda = await ctx.repos.listAgenda(scope.meeting.id);
  await interaction.update({ ...renderAgendaManager(scope.meeting, agenda, selectedId, scope.m), allowedMentions: { parse: [] } });
}

function agendaError(scope: MeetingScope, error: 'locked' | 'full' | 'empty' | 'closed'): string {
  const e = scope.m.errors;
  return { locked: e.agendaLocked, full: e.agendaFull, empty: e.agendaEmptyTitle, closed: e.meetingClosed }[error];
}
