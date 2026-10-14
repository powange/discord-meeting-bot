import type { Guild } from 'discord.js';

/**
 * Membres du serveur en cache (rôles → membres). Avec l'intent GuildMembers, le cache se tient à
 * jour tout seul : la liste complète, coûteuse et limitée en débit sur un gros serveur, n'est
 * téléchargée que s'il manque des membres (premier besoin après le démarrage).
 */
export async function loadMembers(guild: Guild): Promise<void> {
  if (guild.members.cache.size >= guild.memberCount) return;
  await guild.members.fetch();
}
