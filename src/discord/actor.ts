import { PermissionFlagsBits, type Interaction } from 'discord.js';
import type { Actor } from '../domain/permissions.js';

/** Acteur d'une interaction faite dans un serveur (rôles + permission « Gérer les événements »). */
export function actorOf(interaction: Interaction<'cached'>): Actor {
  return {
    userId: interaction.user.id,
    roleIds: [...interaction.member.roles.cache.keys()],
    canManageEvents: interaction.memberPermissions.has(PermissionFlagsBits.ManageEvents),
  };
}
