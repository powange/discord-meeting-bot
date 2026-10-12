import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';

/**
 * Intents :
 * - Guilds : salons, posts de forum, rôles
 * - GuildMembers (privilégié, à activer dans le portail développeur) : relance des membres d'un rôle
 * - GuildMessages : suppression des messages postés dans le post épinglé, et rétablissement des
 *   intégrations retirées des messages du bot (contenu non lu)
 * - GuildVoiceStates : présence dans les vocaux (phase 2)
 * - GuildScheduledEvents : suivi des événements natifs
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildScheduledEvents],
    // Messages partiels : les modifications de messages publiés avant un redémarrage arrivent
    // aussi (rétablissement des intégrations supprimées).
    partials: [Partials.Message],
  });
}

export { Events };
