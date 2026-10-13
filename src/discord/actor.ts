import { PermissionFlagsBits, type Interaction } from 'discord.js';
import type { Actor } from '../domain/permissions.js';

/** Acteur d'une interaction faite dans un serveur (rôles + permissions « Gérer les événements » ou « Gérer le serveur »). */
export function actorOf(interaction: Interaction<'cached'>): Actor {
  return {
    userId: interaction.user.id,
    roleIds: [...interaction.member.roles.cache.keys()],
    // Qui peut configurer le bot (/config) peut aussi gérer les réunions.
    canManageEvents: interaction.memberPermissions.any([PermissionFlagsBits.ManageEvents, PermissionFlagsBits.ManageGuild]),
  };
}
