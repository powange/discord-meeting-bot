import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { AppContext } from '../../context.js';
import { encode, type Action } from '../../domain/customId.js';
import { DEADLINE_CHOICES_H, parseSlotLine, parseSlots, pollDeadline, slotLabel, type Availability } from '../../domain/datePoll.js';
import { DESCRIPTION_MAX, TITLE_MAX } from '../../domain/meeting.js';
import { canCreateMeeting } from '../../domain/permissions.js';
import { messages, type Messages } from '../../i18n/index.js';
import { UserError } from '../../lib/errors.js';
import { actorOf } from '../actor.js';
import { renderPollPanel, renderSlotChoice } from '../embeds/datePoll.js';
import { inviteRows } from '../embeds/meetingManager.js';
import { fetchForum } from '../threads.js';
import { meetingScope, replyEphemeral, requireManager } from './common.js';
import type { ComponentInteraction } from './components.js';

export type PollAction = Extract<Action, { type: `poll.${string}` }>;

const F = { title: 'title', slots: 'slots', deadline: 'deadline', voice: 'voice', description: 'description', slot: 'slot' } as const;

/** Saisies refusées (créneau illisible…), gardées 10 minutes pour rouvrir le formulaire tel quel. */
const drafts = new Map<string, { title: string; slots: string; description: string; at: number }>();

/** Sondage de date : création (post épinglé), réponses (carte), gestion (⚙️ Gérer). */
export async function handleDatePoll(ctx: AppContext, interaction: ComponentInteraction, action: PollAction): Promise<void> {
  switch (action.type) {
    case 'poll.create':
    case 'poll.createRetry': {
      if (!interaction.isButton()) return;
      const draft = action.type === 'poll.createRetry' ? drafts.get(interaction.user.id) : undefined;
      return showCreatePoll(ctx, interaction, draft && Date.now() - draft.at < 10 * 60_000 ? draft : undefined);
    }
    case 'poll.createSubmit': {
      if (!interaction.isModalSubmit()) return;
      return createSubmit(ctx, interaction);
    }
  }

  const scope = await meetingScope(ctx, interaction, action.meetingId);
  const { meeting, m, settings } = scope;
  const p = m.datePoll;
  if (meeting.status !== 'polling') throw new UserError(p.notPolling);

  switch (action.type) {
    case 'poll.answer': {
      if (!interaction.isButton()) return;
      await interaction.reply({ components: [await panel(ctx, meeting, interaction.user.id, m)], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      return;
    }
    case 'poll.vote': {
      if (!interaction.isStringSelectMenu()) return;
      const answer = interaction.values[0] as Availability | undefined;
      if (!answer || !['yes', 'maybe', 'no'].includes(answer)) return;
      if (!(await ctx.repos.listSlots(meeting.id)).some((s) => s.id === action.slotId)) throw new UserError(p.slotGone);
      await ctx.repos.setVote(action.slotId, interaction.user.id, answer);
      await interaction.update({ components: [await panel(ctx, meeting, interaction.user.id, m)], allowedMentions: { parse: [] } });
      ctx.cards.refresh(meeting.id, ['card']);
      return;
    }
    case 'poll.fix':
    case 'poll.remove': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      const choices = await ctx.meetings.slotChoices(meeting);
      const ordered = action.type === 'poll.fix' ? rankById(choices) : choices;
      await interaction.update({ components: [renderSlotChoice(meeting, ordered, action.type === 'poll.fix' ? 'fix' : 'remove', m)], allowedMentions: { parse: [] } });
      return;
    }
    case 'poll.fixSelect':
    case 'poll.removeSelect': {
      if (!interaction.isStringSelectMenu()) return;
      requireManager(scope);
      const slotId = Number(interaction.values[0]);
      await interaction.deferUpdate();
      // Réponse dans le panneau lui-même : un message texte ne peut pas remplacer un panneau
      // Components V2, l'erreur générique du routeur ne s'afficherait pas.
      try {
        if (action.type === 'poll.fixSelect') await ctx.meetings.fixDate(interaction.guild, meeting.id, slotId, interaction.user.id);
        else await ctx.meetings.removeSlot(meeting.id, slotId);
        await interaction.editReply({ components: [notice(action.type === 'poll.fixSelect' ? p.fixedReply : p.slotRemoved)] });
      } catch (err) {
        if (!(err instanceof UserError)) ctx.log.error({ err, meetingId: meeting.id }, 'Action du sondage en échec');
        await interaction.editReply({ components: [notice(`❌ ${err instanceof UserError ? err.message : m.errors.generic('—')}`)] });
      }
      return;
    }
    case 'poll.add': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      const input = new TextInputBuilder().setCustomId(F.slot).setStyle(TextInputStyle.Short).setMaxLength(60).setRequired(true).setPlaceholder('28/10 18h-19h30');
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'poll.addSubmit', meetingId: meeting.id }))
          .setTitle(p.addSlot)
          .addLabelComponents(new LabelBuilder().setLabel(p.addSlotField).setDescription(p.slotsHint).setTextInputComponent(input)),
      );
      return;
    }
    case 'poll.addSubmit': {
      if (!interaction.isModalSubmit()) return;
      requireManager(scope);
      const parsed = parseSlotLine(interaction.fields.getTextInputValue(F.slot), settings.timezone, new Date(), settings.defaultDurationMin);
      if (!parsed.ok) throw new UserError(p.slotError(parsed.error, 1));
      await ctx.meetings.addSlot(meeting.id, parsed.slot);
      await replyEphemeral(interaction, p.slotAdded);
      return;
    }
  }
}

// ---------------------------------------------------------------- interne

async function panel(ctx: AppContext, meeting: { id: string; title: string; guildId: string }, userId: string, m: Messages) {
  const settings = await ctx.settings.get(meeting.guildId);
  const slots = await ctx.repos.listSlots(meeting.id);
  const mine = new Map((await ctx.repos.listVotes(meeting.id)).filter((v) => v.userId === userId).map((v) => [v.slotId, v.answer]));
  return renderPollPanel(
    meeting,
    slots.map((s) => ({ id: s.id, label: slotLabel(s, settings.timezone, settings.locale), answer: mine.get(s.id) ?? null })),
    m,
  );
}

/** Classement (meilleur en tête) appliqué aux choix affichés. */
function rankById<T extends { id: number; yes: number; maybe: number }>(choices: readonly T[]): T[] {
  return [...choices].sort((a, b) => b.yes - a.yes || b.maybe - a.maybe);
}

function notice(text: string) {
  return new ContainerBuilder().setAccentColor(0x57f287).addTextDisplayComponents((t) => t.setContent(text)).toJSON();
}

async function showCreatePoll(ctx: AppContext, interaction: ButtonInteraction<'cached'>, draft?: { title: string; slots: string; description: string }): Promise<void> {
  const settings = await ctx.settings.get(interaction.guildId);
  const m = messages(settings.locale);
  const p = m.datePoll;
  if (!canCreateMeeting(actorOf(interaction), settings)) throw new UserError(m.errors.cannotCreate);
  if (!settings.forumChannelId || !(await fetchForum(ctx.client, settings.forumChannelId))) throw new UserError(m.errors.forumNotConfigured);

  const title = new TextInputBuilder().setCustomId(F.title).setStyle(TextInputStyle.Short).setMaxLength(TITLE_MAX).setRequired(true);
  if (draft?.title) title.setValue(draft.title);
  const slots = new TextInputBuilder().setCustomId(F.slots).setStyle(TextInputStyle.Paragraph).setMaxLength(600).setRequired(true).setPlaceholder(p.slotsPlaceholder);
  if (draft?.slots) slots.setValue(draft.slots);
  const deadline = new StringSelectMenuBuilder()
    .setCustomId(F.deadline)
    .setRequired(true)
    .addOptions(
      ...DEADLINE_CHOICES_H.map((h, i) => ({ label: p.deadlineIn(h), value: String(h), default: i === 2 })),
      { label: p.deadlineEve, value: 'eve' },
    );
  const description = new TextInputBuilder().setCustomId(F.description).setStyle(TextInputStyle.Paragraph).setMaxLength(DESCRIPTION_MAX).setRequired(false).setPlaceholder(m.modal.descriptionHint);
  if (draft?.description) description.setValue(draft.description);

  const modal = new ModalBuilder()
    .setCustomId(encode({ type: 'poll.createSubmit' }))
    .setTitle(p.modalTitle)
    .addLabelComponents(
      new LabelBuilder().setLabel(m.modal.title).setTextInputComponent(title),
      new LabelBuilder().setLabel(p.slotsField).setDescription(p.slotsHint).setTextInputComponent(slots),
      new LabelBuilder().setLabel(p.deadlineField).setStringSelectMenuComponent(deadline),
    );
  // Salon au choix de l'organisateur : demandé tout de suite (imposé ou créé automatiquement : rien à choisir).
  if (!settings.voiceChannelId && !settings.autoVoice) {
    const voice = new ChannelSelectMenuBuilder().setCustomId(F.voice).setChannelTypes(ChannelType.GuildVoice).setRequired(true);
    modal.addLabelComponents(new LabelBuilder().setLabel(m.modal.voice).setChannelSelectMenuComponent(voice));
  }
  modal.addLabelComponents(new LabelBuilder().setLabel(m.modal.description).setTextInputComponent(description));
  await interaction.showModal(modal);
}

async function createSubmit(ctx: AppContext, interaction: ModalSubmitInteraction<'cached'>): Promise<void> {
  const settings = await ctx.settings.get(interaction.guildId);
  const m = messages(settings.locale);
  const p = m.datePoll;
  const title = interaction.fields.getTextInputValue(F.title).trim();
  const slotsText = interaction.fields.getTextInputValue(F.slots);
  const description = interaction.fields.getTextInputValue(F.description).trim();
  const fail = async (message: string) => {
    drafts.set(interaction.user.id, { title, slots: slotsText, description, at: Date.now() });
    const retry = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(encode({ type: 'poll.createRetry' })).setLabel(m.modal.retry).setEmoji('✏️').setStyle(ButtonStyle.Primary),
    );
    await interaction.editReply({ content: `❌ ${message}`, components: [retry], allowedMentions: { parse: [] } });
  };
  if (!title) return fail(m.errors.titleRequired);
  const now = new Date();
  const parsed = parseSlots(slotsText, settings.timezone, now, settings.defaultDurationMin);
  if (!parsed.ok) return fail(p.slotError(parsed.error, parsed.line));
  let voiceChannelId: string | null = null;
  if (!settings.voiceChannelId && !settings.autoVoice) {
    voiceChannelId = interaction.fields.getSelectedChannels(F.voice, false, [ChannelType.GuildVoice])?.first()?.id ?? null;
    if (!voiceChannelId) return fail(m.errors.voiceRequired);
  }
  const choice = interaction.fields.getStringSelectValues(F.deadline)[0] ?? '72';
  const closesAt = pollDeadline(choice === 'eve' ? 'eve' : Number(choice), now, parsed.slots[0]!.startsAt);
  try {
    const meeting = await ctx.meetings.createPoll(interaction.guild, interaction.user.id, { title, description, voiceChannelId, slots: parsed.slots, closesAt });
    drafts.delete(interaction.user.id);
    // Le formulaire est plein (5 éléments au plus) : les rôles à inviter se choisissent ici.
    await interaction.editReply({ content: p.created(meeting.threadId!), components: inviteRows(meeting.id, interaction.guildId, [], m), allowedMentions: { parse: [] } });
  } catch (err) {
    if (err instanceof UserError) return fail(err.message);
    throw err;
  }
}
