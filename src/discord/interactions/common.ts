import { MessageFlags, type Interaction, type RepliableInteraction } from 'discord.js';
import type { AppContext } from '../../context.js';
import type { GuildSettingsRow, MeetingRow } from '../../db/schema.js';
import { canManageMeeting, type Actor } from '../../domain/permissions.js';
import { messages, type Messages } from '../../i18n/index.js';
import { UserError } from '../../lib/errors.js';
import { actorOf } from '../actor.js';
import { noticeText, type NoticeKind } from '../ui/notice.js';

export interface MeetingScope {
  meeting: MeetingRow;
  settings: GuildSettingsRow;
  m: Messages;
  actor: Actor;
  canManage: boolean;
}

/** Charge la réunion visée par une interaction, avec les réglages et droits de l'acteur. */
export async function meetingScope(ctx: AppContext, interaction: Interaction<'cached'>, meetingId: string): Promise<MeetingScope> {
  const settings = await ctx.settings.get(interaction.guildId);
  const m = messages(settings.locale);
  const meeting = await ctx.repos.getMeeting(meetingId);
  if (!meeting || meeting.guildId !== interaction.guildId) throw new UserError(m.errors.meetingNotFound);
  const actor = actorOf(interaction);
  return { meeting, settings, m, actor, canManage: canManageMeeting(meeting, actor, settings) };
}

/** Réunion du post dans lequel la commande est lancée. */
export async function meetingScopeFromChannel(ctx: AppContext, interaction: Interaction<'cached'>): Promise<MeetingScope> {
  const m = await ctx.settings.messages(interaction.guildId);
  const channel = interaction.channel;
  const meeting = channel?.isThread() ? await ctx.repos.getMeetingByThread(channel.id) : undefined;
  if (!meeting) throw new UserError(m.errors.notInMeetingThread);
  return meetingScope(ctx, interaction, meeting.id);
}

export function requireManager(scope: MeetingScope): void {
  // Le refus dit qui peut le faire : l'organisateur, les rôles gestionnaires, les permissions.
  if (!scope.canManage) throw new UserError(scope.m.errors.forbiddenWho(scope.meeting.organizerId, scope.settings.managerRoleIds));
}

/**
 * Réponse éphémère, que l'interaction ait déjà été acquittée ou non. Après un `deferUpdate`
 * (clic sur un message existant), le message d'origine n'est jamais modifié : un panneau
 * Components V2 refuserait le texte (rien ne s'afficherait), et un message public verrait
 * l'erreur s'y ajouter aux yeux de tous. La réponse part alors dans un message privé à part.
 */
export async function replyEphemeral(interaction: RepliableInteraction, content: string): Promise<void> {
  const followUp = () => interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  if (interaction.deferred && interaction.ephemeral === true) {
    // deferReply privé : la réponse en attente devient le message ; s'il est déjà un panneau V2, à part.
    await interaction.editReply({ content, allowedMentions: { parse: [] } }).catch(followUp);
  } else if (interaction.deferred || interaction.replied) {
    await followUp();
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
}

/** Avis éphémère préfixé de l'emoji de sa nature (✅ ❌ ⚠️ ℹ️). */
export function replyNotice(interaction: RepliableInteraction, kind: NoticeKind, text: string): Promise<void> {
  return replyEphemeral(interaction, noticeText(kind, text));
}
