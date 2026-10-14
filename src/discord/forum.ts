import { PermissionFlagsBits, type ForumChannel, type GuildForumTagData, type ThreadChannel } from 'discord.js';
import type { MeetingStatus, StatusTagIds } from '../domain/types.js';
import type { Messages } from '../i18n/index.js';
import { UserError } from '../lib/errors.js';

const TAG_KEYS: Record<MeetingStatus, keyof StatusTagIds> = {
  scheduled: 'upcoming',
  live: 'live',
  ended: 'ended',
  cancelled: 'cancelled',
  polling: 'polling',
};
const TAG_EMOJIS: Record<MeetingStatus, string> = { scheduled: '🗓️', live: '🟢', ended: '✅', cancelled: '❌', polling: '🗳️' };

/** Permissions nécessaires au bot sur le forum. */
export const FORUM_PERMISSIONS = {
  ViewChannel: PermissionFlagsBits.ViewChannel,
  SendMessages: PermissionFlagsBits.SendMessages,
  SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
  ManageThreads: PermissionFlagsBits.ManageThreads,
  ManageMessages: PermissionFlagsBits.ManageMessages,
  ManageChannels: PermissionFlagsBits.ManageChannels,
  EmbedLinks: PermissionFlagsBits.EmbedLinks,
  AttachFiles: PermissionFlagsBits.AttachFiles,
  ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
} as const;

export function missingForumPermissions(forum: ForumChannel): string[] {
  const me = forum.guild.members.me;
  const perms = me ? forum.permissionsFor(me) : null;
  return Object.entries(FORUM_PERMISSIONS)
    .filter(([, flag]) => !perms?.has(flag))
    .map(([name]) => name);
}

/** Création de posts réservée au bot : @everyone n'a plus « Envoyer des messages » sur le forum. */
export function postsReserved(forum: ForumChannel): boolean {
  return forum.permissionOverwrites.cache.get(forum.guild.id)?.deny.has(PermissionFlagsBits.SendMessages) ?? false;
}

/**
 * Réserve (ou rouvre) la création de posts dans le forum. Sur un forum, « Envoyer des messages »
 * permet de créer un post ; répondre dans les posts relève d'« Envoyer des messages dans les
 * fils », qui n'est pas touché. Le bot s'autorise lui-même d'abord (un refus sur @everyone
 * l'emporterait sur les permissions de son rôle), avec seulement les permissions qu'il a déjà.
 * Faux si le bot n'a pas « Gérer les permissions » sur le forum.
 */
export async function setPostsReserved(forum: ForumChannel, reserved: boolean, reason: string): Promise<boolean> {
  const me = forum.guild.members.me;
  if (!me || !forum.permissionsFor(me).has(PermissionFlagsBits.ManageRoles)) return false;
  if (reserved) {
    const own = Object.fromEntries(Object.entries(FORUM_PERMISSIONS).filter(([, flag]) => me.permissions.has(flag) && flag !== PermissionFlagsBits.ManageChannels).map(([name]) => [name, true]));
    await forum.permissionOverwrites.edit(me.id, own, { reason, type: 1 });
    await forum.permissionOverwrites.edit(forum.guild.id, { SendMessages: false }, { reason, type: 0 });
  } else {
    await forum.permissionOverwrites.edit(forum.guild.id, { SendMessages: null }, { reason, type: 0 });
  }
  return true;
}

/**
 * Crée (ou retrouve par leur nom) les tags de statut du forum et renvoie leurs ids.
 * Les tags existants sont conservés : on se contente d'ajouter ceux qui manquent.
 */
export async function ensureStatusTags(forum: ForumChannel, m: Messages): Promise<StatusTagIds> {
  const statuses = Object.keys(TAG_KEYS) as MeetingStatus[];
  const byName = (f: ForumChannel, status: MeetingStatus) => f.availableTags.find((t) => t.name === m.status[status]);

  const missing = statuses.filter((s) => !byName(forum, s));
  let updated = forum;
  if (missing.length > 0) {
    if (forum.availableTags.length + missing.length > 20) throw new UserError('Le forum a déjà trop de tags (20 max).');
    const tags: GuildForumTagData[] = [
      ...forum.availableTags.map((t) => ({ id: t.id, name: t.name, moderated: t.moderated, emoji: t.emoji })),
      ...missing.map((s) => ({ name: m.status[s], moderated: true, emoji: { id: null, name: TAG_EMOJIS[s] } })),
    ];
    updated = await forum.setAvailableTags(tags, 'Tags de statut des réunions');
  }

  const ids = {} as StatusTagIds;
  for (const s of statuses) {
    const tag = byName(updated, s);
    if (!tag) throw new Error(`Tag « ${m.status[s]} » introuvable après création`);
    ids[TAG_KEYS[s]] = tag.id;
  }
  return ids;
}

/** Remplace le tag de statut du post en conservant les autres tags posés à la main. */
export async function applyStatusTag(thread: ThreadChannel, tagIds: StatusTagIds, status: MeetingStatus): Promise<void> {
  const ours = new Set(Object.values(tagIds).filter(Boolean));
  const others = thread.appliedTags.filter((id) => !ours.has(id));
  const tag = tagIds[TAG_KEYS[status]];
  const next = [...(tag ? [tag] : []), ...others].slice(0, 5);
  if (next.length === thread.appliedTags.length && next.every((id) => thread.appliedTags.includes(id))) return;
  await thread.setAppliedTags(next);
}

/** Un post archivé ne peut être ni modifié ni recevoir de message du bot : on le rouvre. */
export async function ensureUnarchived(thread: ThreadChannel): Promise<void> {
  if (thread.archived) await thread.setArchived(false, 'Mise à jour de la réunion');
}
