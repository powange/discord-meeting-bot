import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ModalSubmitInteraction } from 'discord.js';
import type { AppContext } from '../../context.js';
import type { MeetingRow } from '../../db/schema.js';
import { encode, type DraftType } from '../../domain/customId.js';
import type { Messages } from '../../i18n/index.js';
import { UserError } from '../../lib/errors.js';
import { inviteControls, inviteSummary, nextInviteState, type InviteState } from '../embeds/invite.js';
import { roleMention } from '../notify.js';
import type { ComponentInteraction } from './components.js';

/** Réunion ou sondage validé par le formulaire, pas encore créé : en attente du choix « Qui inviter ? ». */
interface Pending {
  kind: 'meeting' | 'poll';
  guildId: string;
  userId: string;
  title: string;
  /** Date, ou créneaux et fin des réponses, déjà formatés. */
  when: string;
  /** Bouton qui rouvre le formulaire prérempli (absent pour une duplication). */
  retryId?: string;
  create: () => Promise<MeetingRow>;
  state: InviteState;
  at: number;
}

const TTL_MS = 15 * 60_000;
const pending = new Map<string, Pending>();

/**
 * Le formulaire est valide : rien n'est encore créé. Le bot garde la saisie et demande qui
 * inviter (rôles, tout le monde, par défaut, personne) ; la création se fait au clic sur « Créer ».
 */
export async function askInvites(
  ctx: AppContext,
  interaction: ModalSubmitInteraction<'cached'>,
  draft: Omit<Pending, 'guildId' | 'userId' | 'state' | 'at'>,
): Promise<void> {
  const now = Date.now();
  for (const [id, p] of pending) if (now - p.at > TTL_MS) pending.delete(id);
  const id = randomBytes(6).toString('hex');
  const p: Pending = { ...draft, guildId: interaction.guildId, userId: interaction.user.id, state: { roleIds: [], none: false }, at: now };
  pending.set(id, p);
  await interaction.editReply({ ...(await render(ctx, id, p)), allowedMentions: { parse: [] } });
}

async function render(ctx: AppContext, id: string, p: Pending, notice?: string) {
  const settings = await ctx.settings.get(p.guildId);
  const m = await ctx.settings.messages(p.guildId);
  const i = m.invite;
  const nudgeRoleId = settings.nudgeRoleId;
  const ids = (verb: string) => encode({ type: `draft.${verb}` as DraftType, draftId: id });
  const content = [
    ...(notice ? [notice, ''] : []),
    i.draft(p.kind, p.title, p.when, nudgeRoleId ? roleMention(nudgeRoleId, p.guildId) : null),
    '',
    i.current(inviteSummary(p.state, p.guildId, nudgeRoleId, m)),
    i.footer,
  ].join('\n');
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ids('create')).setLabel(i.create(p.kind)).setEmoji('✅').setStyle(ButtonStyle.Primary),
  );
  if (p.retryId) actions.addComponents(new ButtonBuilder().setCustomId(p.retryId).setLabel(i.edit).setEmoji('✏️').setStyle(ButtonStyle.Secondary));
  actions.addComponents(new ButtonBuilder().setCustomId(ids('cancel')).setLabel(i.cancel).setStyle(ButtonStyle.Secondary));
  return {
    content,
    components: [...inviteControls({ roles: ids('roles'), everyone: ids('everyone'), default: ids('default'), none: ids('none') }, p.guildId, p.state, nudgeRoleId, m), actions.toJSON()],
  };
}

/** Clics du message « Qui inviter ? ». */
export async function handleDraft(ctx: AppContext, interaction: ComponentInteraction, action: { type: DraftType; draftId: string }): Promise<void> {
  if (interaction.isModalSubmit()) return;
  const m: Messages = await ctx.settings.messages(interaction.guildId);
  const p = pending.get(action.draftId);
  if (!p || p.userId !== interaction.user.id || Date.now() - p.at > TTL_MS) {
    pending.delete(action.draftId);
    await interaction.update({ content: m.invite.expired, components: [], allowedMentions: { parse: [] } });
    return;
  }
  const verb = action.type.split('.')[1] as 'roles' | 'everyone' | 'default' | 'none' | 'create' | 'cancel';

  if (verb === 'cancel') {
    pending.delete(action.draftId);
    await interaction.update({ content: m.invite.cancelled, components: [], allowedMentions: { parse: [] } });
    return;
  }

  if (verb === 'create') {
    await interaction.deferUpdate();
    try {
      const meeting = await p.create();
      pending.delete(action.draftId);
      // « Par défaut » : rien à enregistrer, le rôle relancé de /config s'applique.
      if (p.state.none || p.state.roleIds.length) await ctx.meetings.inviteRoles(interaction.guild, meeting.id, p.state.roleIds, p.state.none);
      const settings = await ctx.settings.get(p.guildId);
      await interaction.editReply({ content: m.invite.created(p.kind, meeting.threadId!, inviteSummary(p.state, p.guildId, settings.nudgeRoleId, m)), components: [], allowedMentions: { parse: [] } });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      await interaction.editReply({ ...(await render(ctx, action.draftId, p, `❌ ${err.message}`)), allowedMentions: { parse: [] } });
    }
    return;
  }

  if (verb === 'roles') {
    if (!interaction.isRoleSelectMenu()) return;
    p.state = nextInviteState(p.state, p.guildId, 'roles', [...interaction.roles.keys()]);
  } else {
    if (!interaction.isButton()) return;
    p.state = nextInviteState(p.state, p.guildId, verb);
  }
  await interaction.update({ ...(await render(ctx, action.draftId, p)), allowedMentions: { parse: [] } });
}
