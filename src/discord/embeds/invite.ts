import { ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder } from 'discord.js';
import type { Messages } from '../../i18n/index.js';
import { roleMention } from '../notify.js';

/**
 * Qui inviter : des rôles (le rôle @everyone a l'identifiant du serveur), personne, ou — ni l'un ni
 * l'autre — le réglage par défaut (rôle relancé de /config).
 */
export interface InviteState {
  roleIds: readonly string[];
  none: boolean;
}

export type InviteChoice = 'roles' | 'everyone' | 'default' | 'none';

/** Identifiants des contrôles (brouillon de création ou réunion existante). */
export interface InviteIds {
  roles: string;
  everyone: string;
  default: string;
  none: string;
}

export function inviteChoice(state: InviteState, guildId: string): InviteChoice {
  if (state.none) return 'none';
  if (state.roleIds.length === 0) return 'default';
  return state.roleIds.length === 1 && state.roleIds[0] === guildId ? 'everyone' : 'roles';
}

/** Choix actuel, en clair. */
export function inviteSummary(state: InviteState, guildId: string, nudgeRoleId: string | null, m: Messages): string {
  const i = m.invite;
  switch (inviteChoice(state, guildId)) {
    case 'none':
      return i.summaryNone;
    case 'default':
      return nudgeRoleId ? i.summaryDefault(roleMention(nudgeRoleId, guildId)) : i.summaryNone;
    default:
      return i.summaryRoles(state.roleIds.map((id) => roleMention(id, guildId)).join(' '));
  }
}

/**
 * Sélecteur de rôles (jusqu'à 5) et boutons Tout le monde / Par défaut / Personne ; le choix actif
 * est en vert. « Par défaut » n'apparaît que si un rôle relancé est réglé dans /config.
 */
export function inviteControls(ids: InviteIds, guildId: string, state: InviteState, nudgeRoleId: string | null, m: Messages) {
  const i = m.invite;
  const choice = inviteChoice(state, guildId);
  const roles = state.roleIds.filter((id) => id !== guildId);
  const select = new RoleSelectMenuBuilder().setCustomId(ids.roles).setPlaceholder(i.roles).setMinValues(0).setMaxValues(5);
  if (roles.length) select.setDefaultRoles(...roles);
  const everyone = state.roleIds.includes(guildId);
  const button = (id: string, label: string, emoji: string, active: boolean) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(active ? ButtonStyle.Success : ButtonStyle.Secondary);
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(button(ids.everyone, everyone ? i.everyoneOff : i.everyoneOn, '📣', everyone));
  if (nudgeRoleId) buttons.addComponents(button(ids.default, i.defaultButton, '↩️', choice === 'default'));
  buttons.addComponents(button(ids.none, i.noneButton, '🚫', choice === 'none'));
  return [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select).toJSON(), buttons.toJSON()];
}

/** Nouvel état après un clic : rôles choisis (Tout le monde conservé), Tout le monde basculé, Par défaut, Personne. */
export function nextInviteState(state: InviteState, guildId: string, action: 'roles' | 'everyone' | 'default' | 'none', selected: readonly string[] = []): InviteState {
  const everyone = state.roleIds.includes(guildId);
  switch (action) {
    case 'roles':
      return { roleIds: [...selected.filter((id) => id !== guildId).slice(0, 5), ...(everyone ? [guildId] : [])], none: false };
    case 'everyone':
      return { roleIds: everyone ? state.roleIds.filter((id) => id !== guildId) : [...state.roleIds, guildId], none: false };
    case 'default':
      return { roleIds: [], none: false };
    case 'none':
      return { roleIds: [], none: true };
  }
}
