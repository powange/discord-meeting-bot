import { loadConfig } from './config/index.js';
import type { AppContext } from './context.js';
import { createDb, runMigrations } from './db/client.js';
import { Repositories } from './db/repositories.js';
import { createClient, Events } from './discord/client.js';
import { routeInteraction } from './discord/interactions/router.js';
import { registerCommands } from './discord/registerCommands.js';
import { createLogger } from './lib/logger.js';
import { Scheduler } from './scheduler/index.js';
import { CardService } from './services/cards.js';
import { HubService } from './services/hub.js';
import { MeetingService } from './services/meetings.js';
import { SettingsService } from './services/settings.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  const { db, pool } = createDb(config.database.url);
  await runMigrations(db);
  log.info('Migrations appliquées');

  const client = createClient();
  const repos = new Repositories(db);
  const settings = new SettingsService(repos, config);
  const cards = new CardService(client, repos, settings, log);
  const hub = new HubService(client, repos, settings, log);
  const meetings = new MeetingService(client, repos, settings, cards, log, (guildId) => hub.refresh(guildId));
  const ctx: AppContext = { config, client, log, repos, settings, cards, hub, meetings };
  const scheduler = new Scheduler(ctx);
  await hub.load();

  client.once(Events.ClientReady, async (ready) => {
    log.info({ user: ready.user.tag, guilds: ready.guilds.cache.size }, 'Connecté à Discord');
    try {
      await registerCommands(ready, config.discord.commandGuildIds, log);
    } catch (err) {
      log.error({ err }, 'Enregistrement des commandes impossible');
    }
    scheduler.start();
    hub.startWatchdog();
  });
  client.on(Events.InteractionCreate, (interaction) => void routeInteraction(ctx, interaction));
  client.on(Events.MessageCreate, (message) => {
    hub.onMessage(message).catch((err) => log.warn({ err }, 'Filtrage du post épinglé impossible'));
  });
  client.on(Events.ThreadDelete, (thread) => {
    meetings.onThreadDeleted(thread.id).catch((err) => log.error({ err, threadId: thread.id }, 'Suppression de post non traitée'));
    hub.onThreadDelete(thread.id, thread.guildId).catch((err) => log.error({ err, threadId: thread.id }, 'Recréation du post épinglé impossible'));
  });
  client.on(Events.ThreadUpdate, (_old, thread) => {
    hub.onThreadUpdate(thread).catch((err) => log.warn({ err, threadId: thread.id }, 'Rétablissement du post épinglé impossible'));
  });
  client.on(Events.Error, (err) => log.error({ err }, 'Erreur du client Discord'));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'Arrêt en cours');
    const force = setTimeout(() => process.exit(1), 15_000).unref();
    await scheduler.stop().catch(() => undefined);
    await hub.stopWatchdog().catch(() => undefined);
    await cards.flush().catch(() => undefined);
    await hub.flush().catch(() => undefined);
    await client.destroy();
    await pool.end();
    clearTimeout(force);
    log.info('Arrêté');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'Promesse rejetée non gérée'));

  await client.login(config.discord.token);
}

main().catch((err) => {
  // Le logger n'existe peut-être pas encore (config invalide) : sortie brute.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
