import { Client, Events, GatewayIntentBits } from 'discord.js';

/**
 * Intents :
 * - Guilds : salons, posts de forum, rôles
 * - GuildMembers (privilégié, à activer dans le portail développeur) : relance des membres d'un rôle
 * - GuildVoiceStates : présence dans les vocaux (phase 2)
 * - GuildScheduledEvents : suivi des événements natifs
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildScheduledEvents],
  });
}

export { Events };
