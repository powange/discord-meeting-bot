import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { AppContext } from '../../context.js';
import { AGENDA_DETAIL_MAX, AGENDA_TITLE_MAX, canEditItem, checkAddItem, moveItem } from '../../domain/agenda.js';
import { encode, type Action } from '../../domain/customId.js';
import { NOTE_KINDS, nextPoint, type NoteKind } from '../../domain/markers.js';
import { canReschedule, isOpen } from '../../domain/meeting.js';
import { canCreateMeeting } from '../../domain/permissions.js';
import { messages, type Messages } from '../../i18n/index.js';
import { UserError } from '../../lib/errors.js';
import { actorOf } from '../actor.js';
import { renderAgendaManager } from '../embeds/meetingCard.js';
import { OFF_AGENDA } from '../embeds/recordingControl.js';
import { fetchForum } from '../threads.js';
import { agendaItemModal, duplicateModal, meetingModal, readAgendaItemModal, readDuplicateModal, readMeetingDraft, readMeetingModal, type MeetingDraft } from '../modals.js';
import { renderMeetingManager } from '../embeds/meetingManager.js';
import { formatWhen } from '../../domain/time.js';
import type { MeetingRow } from '../../db/schema.js';
import { meetingScope, replyEphemeral, requireManager, type MeetingScope } from './common.js';
import { handleDatePoll, type PollAction } from './datePoll.js';

export type ComponentInteraction = ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'> | ModalSubmitInteraction<'cached'>;

/** Traite un bouton, menu ou formulaire dont le customId a été décodé. */
export async function handleAction(
  ctx: AppContext,
  interaction: ComponentInteraction,
  rawAction: Exclude<Action, { type: 'tx' } | { type: 'cfg' } | { type: 'consent.open' } | { type: 'consent.refuse' } | { type: 'consent.accept' }>,
): Promise<void> {
  if (rawAction.type === 'meeting.create') {
    if (!interaction.isButton()) return;
    return showCreateModal(ctx, interaction);
  }
  if (rawAction.type === 'meeting.createSubmit') {
    if (!interaction.isModalSubmit()) return;
    return createSubmit(ctx, interaction);
  }
  if (rawAction.type === 'meeting.createRetry') {
    if (!interaction.isButton()) return;
    return showCreateModal(ctx, interaction, drafts.take(interaction.user.id, 'create'));
  }
  if (rawAction.type.startsWith('poll.')) return handleDatePoll(ctx, interaction, rawAction as PollAction);

  // Actions portant sur une réunion existante.
  const action = rawAction as Exclude<typeof rawAction, PollAction | { type: 'meeting.create' | 'meeting.createSubmit' | 'meeting.createRetry' }>;
  const scope = await meetingScope(ctx, interaction, action.meetingId);
  const { meeting, m } = scope;

  switch (action.type) {
    case 'rsvp': {
      if (!interaction.isButton()) return;
      if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
      if (meeting.status === 'polling') throw new UserError(m.datePoll.answerFirst);
      // Second clic sur la réponse déjà donnée : elle est retirée.
      const current = (await ctx.repos.listRsvps(meeting.id)).find((r) => r.userId === interaction.user.id)?.status;
      if (current === action.status) await ctx.repos.deleteRsvp(meeting.id, interaction.user.id);
      else await ctx.repos.setRsvp(meeting.id, interaction.user.id, action.status);
      ctx.cards.refresh(meeting.id, ['card']);
      await replyEphemeral(interaction, current === action.status ? m.replies.rsvpRemoved : m.replies.rsvpSaved(m.rsvp[action.status]));
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
      ctx.cards.refresh(meeting.id, ['agenda']);
      await replyEphemeral(interaction, m.replies.itemAdded(item.title));
      return;
    }

    case 'agenda.manage': {
      if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
      // Gestionnaires : tout l'ODJ. Les autres : leurs propres points, tant que l'ODJ est ouvert.
      if (!scope.canManage) {
        if (meeting.agendaLocked) throw new UserError(m.errors.agendaLocked);
        const own = (await ctx.repos.listAgenda(meeting.id)).filter((i) => i.authorId === interaction.user.id);
        if (own.length === 0) throw new UserError(m.agendaManager.noOwnItems);
        await interaction.reply({ ...renderAgendaManager(meeting, own, null, m, 'author'), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return;
      }
      const agenda = await ctx.repos.listAgenda(meeting.id);
      await interaction.reply({ ...renderAgendaManager(meeting, agenda, null, m), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }

    case 'agenda.select': {
      if (!interaction.isStringSelectMenu()) return;
      const selected = Number(interaction.values[0]);
      await updateManager(ctx, interaction, scope, Number.isInteger(selected) ? selected : null);
      return;
    }

    case 'agenda.edit': {
      if (!interaction.isButton()) return;
      const item = (await ctx.repos.listAgenda(meeting.id)).find((i) => i.id === action.itemId);
      if (!item) throw new UserError(m.errors.agendaItemGone);
      const allowed = canEditItem({ actorIsManager: scope.canManage, isAuthor: item.authorId === interaction.user.id, locked: meeting.agendaLocked, meetingOpen: isOpen(meeting.status) });
      if (!allowed) throw new UserError(meeting.agendaLocked ? m.errors.agendaLocked : m.errors.forbidden);
      await interaction.showModal(agendaItemModal(m, encode({ type: 'agenda.editSubmit', meetingId: meeting.id, itemId: item.id }), item));
      return;
    }

    case 'agenda.editSubmit': {
      if (!interaction.isModalSubmit()) return;
      const item = (await ctx.repos.listAgenda(meeting.id)).find((i) => i.id === action.itemId);
      if (!item) throw new UserError(m.errors.agendaItemGone);
      const allowed = canEditItem({ actorIsManager: scope.canManage, isAuthor: item.authorId === interaction.user.id, locked: meeting.agendaLocked, meetingOpen: isOpen(meeting.status) });
      if (!allowed) throw new UserError(meeting.agendaLocked ? m.errors.agendaLocked : m.errors.forbidden);
      const input = readAgendaItemModal(interaction);
      const title = input.title.trim().slice(0, AGENDA_TITLE_MAX);
      if (!title) throw new UserError(m.errors.agendaEmptyTitle);
      await ctx.repos.updateAgendaItem(meeting.id, item.id, { title, detail: input.detail.trim().slice(0, AGENDA_DETAIL_MAX) });
      ctx.cards.refresh(meeting.id, ['agenda']);
      await replyEphemeral(interaction, m.replies.itemUpdated(title));
      return;
    }

    case 'agenda.remove': {
      // Retrait : confirmation d'abord (rien ne permet de récupérer un point retiré).
      if (!interaction.isButton()) return;
      requireManager(scope);
      await updateManager(ctx, interaction, scope, action.itemId, true);
      return;
    }

    case 'agenda.move':
    case 'agenda.removeConfirm': {
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
      ctx.cards.refresh(meeting.id, ['agenda']);
      return;
    }

    case 'agenda.lock': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      const updated = await ctx.repos.updateMeeting(meeting.id, { agendaLocked: action.locked });
      await updateManager(ctx, interaction, { ...scope, meeting: updated ?? meeting }, null);
      ctx.cards.refresh(meeting.id, ['agenda']);
      return;
    }

    case 'report.correct': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'report.correctSubmit', meetingId: meeting.id }))
          .setTitle(m.report.correctModal)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(m.report.correctField)
              .setDescription(m.report.correctHint)
              .setTextInputComponent(new TextInputBuilder().setCustomId('correction').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)),
          ),
      );
      return;
    }

    case 'report.correctSubmit': {
      if (!interaction.isModalSubmit()) return;
      requireManager(scope);
      const correction = interaction.fields.getTextInputValue('correction').trim();
      if (ctx.pipeline.isQueued(meeting.id)) throw new UserError(m.pipeline.running_reply);
      if (!(await ctx.repos.addCorrection(meeting.id, correction))) throw new UserError(m.report.correctNoSummary);
      await ctx.pipeline.regenerate(meeting.id, false, interaction.user.id);
      await replyEphemeral(interaction, m.report.correctSaved);
      return;
    }

    case 'report.regen': {
      // Nouveau résumé à partir de la même transcription, sans consigne supplémentaire.
      if (!interaction.isButton()) return;
      requireManager(scope);
      if (ctx.recordings.isRecording(meeting.id)) throw new UserError(m.errors.alreadyRecording);
      if (ctx.pipeline.isQueued(meeting.id)) throw new UserError(m.pipeline.running_reply);
      await ctx.pipeline.regenerate(meeting.id, false, interaction.user.id);
      await replyEphemeral(interaction, m.pipeline.scheduled);
      return;
    }

    case 'report.retry': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await ctx.pipeline.retry(meeting.id);
      await replyEphemeral(interaction, m.pipeline.retried); // le message de suivi se met à jour de lui-même
      return;
    }

    case 'rec.start': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // la connexion au vocal peut prendre plusieurs secondes
      await ctx.meetings.ensureVoice(meeting.id); // salon temporaire : créé à la demande s'il n'existe pas encore
      await ctx.recordings.start(meeting.id, interaction.user.id);
      await replyEphemeral(interaction, m.recording.started_reply);
      return;
    }

    case 'rec.stop': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const stopped = await ctx.recordings.stop(meeting.id, 'manual', interaction.user.id);
      // Déjà arrêté (redémarrage du bot, autre clic) : le message à boutons est remis à jour.
      if (!stopped) await ctx.recordings.syncControl(meeting.id);
      await replyEphemeral(interaction, stopped ? m.recording.stopped_reply : m.recording.alreadyStopped);
      return;
    }

    // ---------------------------------------------------------------- repères en direct

    case 'rec.next':
    case 'rec.goto': {
      // Passage au point suivant (ou au point choisi) : réservé à l'animateur (organisateur, gestionnaire).
      if (action.type === 'rec.next' ? !interaction.isButton() : !interaction.isStringSelectMenu()) return;
      requireManager(scope);
      if (!(await ctx.repos.getActiveRecording(meeting.id))) {
        await ctx.recordings.syncControl(meeting.id); // message resté d'avant un arrêt (redémarrage)
        throw new UserError(m.control.notRecording);
      }
      const agenda = await ctx.repos.listAgenda(meeting.id);
      let target: number | null;
      if (interaction.isStringSelectMenu()) {
        const value = interaction.values[0] ?? '';
        target = value === OFF_AGENDA ? null : (agenda.find((a) => String(a.id) === value)?.id ?? null);
      } else {
        target = nextPoint(agenda, await ctx.repos.listMarkers(meeting.id));
      }
      await ctx.repos.addMarker({ meetingId: meeting.id, kind: 'agenda', at: new Date(), agendaItemId: target, authorId: interaction.user.id });
      const index = agenda.findIndex((a) => a.id === target);
      await replyEphemeral(interaction, m.control.pointSet(index >= 0 ? `${index + 1}. ${agenda[index]!.title}` : m.control.offAgendaOption));
      await ctx.recordings.syncControl(meeting.id);
      return;
    }

    case 'rec.note': {
      if (!interaction.isButton()) return;
      if (!(await ctx.repos.getActiveRecording(meeting.id))) {
        await ctx.recordings.syncControl(meeting.id); // message resté d'avant un arrêt (redémarrage)
        throw new UserError(m.control.notRecording);
      }
      const c = m.control;
      const kind = new StringSelectMenuBuilder()
        .setCustomId('kind')
        .addOptions(NOTE_KINDS.map((k) => ({ label: c.noteKinds[k]!, value: k, default: k === 'note' })));
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'rec.noteSubmit', meetingId: meeting.id }))
          .setTitle(c.noteModal)
          .addLabelComponents(
            new LabelBuilder().setLabel(c.noteKind).setStringSelectMenuComponent(kind),
            new LabelBuilder().setLabel(c.noteText).setTextInputComponent(new TextInputBuilder().setCustomId('text').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)),
            new LabelBuilder().setLabel(c.noteWho).setTextInputComponent(new TextInputBuilder().setCustomId('who').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false)),
          ),
      );
      return;
    }

    case 'rec.noteSubmit': {
      if (!interaction.isModalSubmit()) return;
      // Horodatée à l'envoi du formulaire. Une note arrivée juste après l'arrêt est gardée : elle
      // tombe à la fin de la transcription.
      const value = interaction.fields.getStringSelectValues('kind')[0];
      const kind: NoteKind = NOTE_KINDS.includes(value as NoteKind) ? (value as NoteKind) : 'note';
      const who = interaction.fields.getTextInputValue('who').trim();
      await ctx.repos.addMarker({
        meetingId: meeting.id,
        kind,
        at: new Date(),
        text: interaction.fields.getTextInputValue('text').trim(),
        who: kind === 'action' && who ? who : null,
        authorId: interaction.user.id,
      });
      await replyEphemeral(interaction, m.control.noteSaved);
      await ctx.recordings.syncControl(meeting.id);
      return;
    }

    // ---------------------------------------------------------------- panneau « Gérer »

    case 'meeting.manage': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      const payload = { components: [await managerPanel(ctx, meeting)] };
      // Ouvert depuis la carte : nouveau message privé ; « Retour » depuis le panneau : mise à jour.
      if (interaction.message.flags.has(MessageFlags.Ephemeral)) await interaction.update(payload);
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
      return;
    }

    case 'meeting.autoRecord': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await ctx.meetings.setAutoRecord(meeting.id, !meeting.autoRecord);
      const updated = (await ctx.repos.getMeeting(meeting.id)) ?? meeting;
      await interaction.update({ components: [await managerPanel(ctx, updated, { notice: m.recording.autoSet(updated.autoRecord) })] });
      return;
    }

    case 'meeting.end': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.update({ components: [await managerPanel(ctx, meeting, { confirmEnd: true, notice: m.manage.endAsk })] });
      return;
    }

    case 'meeting.endConfirm': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.deferUpdate();
      const ok = await ctx.meetings.end(meeting.id, interaction.user.id);
      const updated = (await ctx.repos.getMeeting(meeting.id)) ?? meeting;
      await interaction.editReply({ components: [await managerPanel(ctx, updated, { notice: ok ? m.replies.ended : m.errors.meetingClosed })] });
      return;
    }

    case 'meeting.cancel': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'meeting.cancelSubmit', meetingId: meeting.id }))
          .setTitle(m.manage.cancelModal)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(m.manage.cancelReason)
              .setDescription(m.manage.cancelReasonHint)
              .setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false)),
          ),
      );
      return;
    }

    case 'meeting.cancelSubmit': {
      if (!interaction.isModalSubmit()) return;
      requireManager(scope);
      const reason = interaction.fields.getTextInputValue('reason').trim() || null;
      const ok = await ctx.meetings.cancel(meeting.id, interaction.user.id, reason);
      await replyEphemeral(interaction, ok ? m.replies.cancelled : m.errors.meetingClosed);
      return;
    }

    case 'meeting.duplicate': {
      if (!interaction.isButton()) return;
      if (!canCreateMeeting(scope.actor, scope.settings)) throw new UserError(m.errors.cannotCreate);
      await interaction.showModal(
        duplicateModal(m, {
          customId: encode({ type: 'meeting.duplicateSubmit', meetingId: meeting.id }),
          timezone: scope.settings.timezone,
          locale: scope.settings.locale,
          startsAt: meeting.startsAt,
          durationMin: meeting.durationMin,
          title: meeting.title,
          description: meeting.description,
        }),
      );
      return;
    }

    case 'meeting.duplicateSubmit': {
      if (!interaction.isModalSubmit()) return;
      if (!canCreateMeeting(scope.actor, scope.settings)) throw new UserError(m.errors.cannotCreate);
      const input = readDuplicateModal(interaction, m, scope.settings.timezone, meeting.durationMin);
      const copy = await ctx.meetings.create(
        interaction.guild,
        interaction.user.id,
        // Un salon temporaire appartient à la réunion d'origine (il sera supprimé) : la copie ne le reprend pas.
        { title: input.title, description: input.description, startsAt: input.startsAt, durationMin: input.durationMin, voiceChannelId: meeting.voiceTemporary ? null : meeting.voiceChannelId },
        input.copyAgenda ? { copyAgendaFrom: meeting.id } : {},
      );
      await replyEphemeral(interaction, m.replies.duplicated(copy.threadId!));
      return;
    }

    case 'meeting.regenAll': {
      // Long et coûteux (GPU) : confirmation d'abord.
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.update({ components: [await managerPanel(ctx, meeting, { confirmRegenAll: true, notice: m.manage.regenAllAsk })] });
      return;
    }

    case 'meeting.regen':
    case 'meeting.regenAllConfirm': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      const retranscribe = action.type === 'meeting.regenAllConfirm';
      const recordings = await ctx.repos.listRecordingsForMeeting(meeting.id);
      let notice: string;
      if (recordings.length === 0) notice = m.pipeline.nothing;
      else if (ctx.recordings.isRecording(meeting.id)) notice = m.errors.alreadyRecording;
      else if (ctx.pipeline.isQueued(meeting.id)) notice = m.pipeline.running_reply;
      else if (retranscribe && recordings.some((r) => r.purgedAt)) {
        const purged = recordings.find((r) => r.purgedAt)!;
        notice = m.pipeline.purged(formatWhen(purged.purgedAt!, scope.settings.timezone, scope.settings.locale, m.format.when));
      } else {
        await ctx.pipeline.regenerate(meeting.id, retranscribe, interaction.user.id);
        notice = m.pipeline.scheduled;
      }
      await interaction.update({ components: [await managerPanel(ctx, meeting, { notice })] });
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
      await withDraft(interaction, m, meeting.id, encode({ type: 'meeting.editRetry', meetingId: meeting.id }), async () => {
        const input = readMeetingModal(interaction, m, {
          timezone: scope.settings.timezone,
          defaultDurationMin: scope.settings.defaultDurationMin,
          fixedVoiceChannelId: scope.settings.voiceChannelId,
          autoVoice: scope.settings.autoVoice,
          reschedulable: canReschedule(meeting.status),
          current: meeting,
        });
        await ctx.meetings.update(interaction.guild, meeting, input, interaction.user.id);
        await replyEphemeral(interaction, m.replies.updated);
      });
      return;
    }

    case 'meeting.editRetry': {
      if (!interaction.isButton()) return;
      await showEditModal(interaction, scope, drafts.take(interaction.user.id, meeting.id));
      return;
    }
  }
}

/** Ouvre le formulaire de modification (panneau « Gérer » → Modifier). */
export async function showEditModal(interaction: ButtonInteraction<'cached'> | ChatInputCommandInteraction<'cached'>, scope: MeetingScope, draft?: MeetingDraft): Promise<void> {
  requireManager(scope);
  const { meeting, m } = scope;
  if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
  await interaction.showModal(
    meetingModal(m, {
      customId: encode({ type: 'meeting.editSubmit', meetingId: meeting.id }),
      heading: m.modal.editTitle,
      reschedulable: canReschedule(meeting.status),
      timezone: scope.settings.timezone,
      locale: scope.settings.locale,
      defaultDurationMin: scope.settings.defaultDurationMin,
      fixedVoiceChannelId: scope.settings.voiceChannelId,
      autoVoice: scope.settings.autoVoice,
      defaults: meeting,
      ...(draft ? { draft } : {}),
    }),
  );
}

/** Ouvre le formulaire de création (bouton « Nouvelle réunion » du post épinglé). */
export async function showCreateModal(
  ctx: AppContext,
  interaction: ButtonInteraction<'cached'>,
  draft?: MeetingDraft,
): Promise<void> {
  const settings = await ctx.settings.get(interaction.guildId);
  const m = messages(settings.locale);
  if (!canCreateMeeting(actorOf(interaction), settings)) throw new UserError(m.errors.cannotCreate);
  if (!settings.forumChannelId || !(await fetchForum(ctx.client, settings.forumChannelId))) throw new UserError(m.errors.forumNotConfigured);
  await interaction.showModal(
    meetingModal(m, {
      customId: encode({ type: 'meeting.createSubmit' }),
      heading: m.modal.createTitle,
      reschedulable: true,
      timezone: settings.timezone,
      locale: settings.locale,
      defaultDurationMin: settings.defaultDurationMin,
      fixedVoiceChannelId: settings.voiceChannelId,
      autoVoice: settings.autoVoice,
      defaults: {},
      ...(draft ? { draft } : {}),
    }),
  );
}

async function createSubmit(ctx: AppContext, interaction: ModalSubmitInteraction<'cached'>): Promise<void> {
  const settings = await ctx.settings.get(interaction.guildId);
  const m = messages(settings.locale);
  await withDraft(interaction, m, 'create', encode({ type: 'meeting.createRetry' }), async () => {
    const input = readMeetingModal(interaction, m, {
      timezone: settings.timezone,
      reschedulable: true,
      defaultDurationMin: settings.defaultDurationMin,
      fixedVoiceChannelId: settings.voiceChannelId,
      autoVoice: settings.autoVoice,
    });
    const meeting = await ctx.meetings.create(interaction.guild, interaction.user.id, input);
    await replyEphemeral(interaction, m.replies.created(meeting.threadId!));
  });
}

/** Saisies refusées, gardées 10 minutes par personne pour rouvrir le formulaire tel quel. */
const drafts = new (class {
  private readonly entries = new Map<string, { draft: MeetingDraft; at: number }>();
  save(userId: string, key: string, draft: MeetingDraft): void {
    const now = Date.now();
    for (const [k, v] of this.entries) if (now - v.at > 10 * 60_000) this.entries.delete(k);
    this.entries.set(`${userId}:${key}`, { draft, at: now });
  }
  take(userId: string, key: string): MeetingDraft | undefined {
    const entry = this.entries.get(`${userId}:${key}`);
    return entry && Date.now() - entry.at <= 10 * 60_000 ? entry.draft : undefined;
  }
})();

/**
 * Formulaire refusé (date illisible, salon manquant…) : au lieu de tout faire ressaisir, on
 * garde la saisie et on propose de rouvrir le formulaire prérempli.
 */
async function withDraft(interaction: ModalSubmitInteraction<'cached'>, m: Messages, key: string, retryId: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    drafts.save(interaction.user.id, key, readMeetingDraft(interaction));
    const retry = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(retryId).setLabel(m.modal.retry).setEmoji('✏️').setStyle(ButtonStyle.Primary));
    const payload = { content: `❌ ${err.message}`, components: [retry], allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

/** Panneau « Gérer » d'une réunion. */
async function managerPanel(ctx: AppContext, meeting: MeetingRow, state: { confirmEnd?: boolean; confirmRegenAll?: boolean; notice?: string } = {}) {
  const m = await ctx.settings.messages(meeting.guildId);
  const hasRecording = (await ctx.repos.listRecordingsForMeeting(meeting.id)).length > 0;
  return renderMeetingManager(meeting, { hasRecording, recording: ctx.recordings.isRecording(meeting.id), ...state }, m);
}

async function updateManager(
  ctx: AppContext,
  interaction: ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>,
  scope: MeetingScope,
  selectedId: number | null,
  confirmRemove = false,
): Promise<void> {
  const all = await ctx.repos.listAgenda(scope.meeting.id);
  const agenda = scope.canManage ? all : all.filter((i) => i.authorId === interaction.user.id);
  await interaction.update({
    ...renderAgendaManager(scope.meeting, agenda, selectedId, scope.m, scope.canManage ? 'manager' : 'author', confirmRemove),
    allowedMentions: { parse: [] },
  });
}

function agendaError(scope: MeetingScope, error: 'locked' | 'full' | 'empty' | 'closed'): string {
  const e = scope.m.errors;
  return { locked: e.agendaLocked, full: e.agendaFull, empty: e.agendaEmptyTitle, closed: e.meetingClosed }[error];
}
