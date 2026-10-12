import { loadConfig } from './config/index.js';
import type { AppContext } from './context.js';
import { createDb, runMigrations } from './db/client.js';
import { Repositories } from './db/repositories.js';
import { createClient, Events } from './discord/client.js';
import { routeInteraction } from './discord/interactions/router.js';
import { registerCommands } from './discord/registerCommands.js';
import { createLogger } from './lib/logger.js';
import { PipelineService } from './pipeline/runner.js';
import { createSteps } from './pipeline/steps.js';
import { Scheduler } from './scheduler/index.js';
import { CardService } from './services/cards.js';
import { HubService } from './services/hub.js';
import { MeetingService } from './services/meetings.js';
import { OwnersService } from './services/owners.js';
import { RetentionService } from './services/retention.js';
import { MeetingWatcher } from './services/meetingWatcher.js';
import { RecordingService } from './services/recordings.js';
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
  const meetings = new MeetingService(config, client, repos, settings, cards, log, (guildId) => hub.refresh(guildId));
  const recordings = new RecordingService(client, repos, settings, cards, config, log);
  const pipelineDeps = { client, repos, settings, config, log };
  const pipeline = new PipelineService(pipelineDeps, createSteps(pipelineDeps));
  meetings.hooks = {
    afterStart: (meeting) => recordings.onMeetingStarted(meeting),
    beforeClose: (meetingId) => recordings.onMeetingClosing(meetingId),
    afterEnd: (meetingId) => pipeline.processIfNeeded(meetingId),
  };
  recordings.setOnStopped((meetingId) => pipeline.refresh(meetingId));
  const owners = new OwnersService(config.owners);
  const ctx: AppContext = { config, client, log, repos, settings, cards, hub, meetings, recordings, pipeline, owners };
  const scheduler = new Scheduler(ctx);
  const watcher = new MeetingWatcher(client, repos, meetings, config, log);
  const retention = new RetentionService(repos, config, log);
  await hub.load();

  client.once(Events.ClientReady, async (ready) => {
    log.info({ user: ready.user.tag, guilds: ready.guilds.cache.size }, 'Connecté à Discord');
    await owners.load(ready, log);
    try {
      await registerCommands(ready, config.discord.commandGuildIds, log);
    } catch (err) {
      log.error({ err }, 'Enregistrement des commandes impossible');
    }
    await recordings.recoverInterrupted().catch((err) => log.error({ err }, 'Reprise des enregistrements interrompus impossible'));
    scheduler.start();
    watcher.start();
    retention.start();
    await pipeline.resume().catch((err) => log.error({ err }, 'Reprise des comptes rendus impossible'));
    hub.startWatchdog();
    // Une nouvelle version peut changer la carte (ex. bouton d'enregistrement) : on régénère celles
    // des réunions ouvertes, sans notification (simple édition des messages existants).
    for (const meeting of await repos.listOpenMeetings().catch(() => [])) {
      cards.refresh(meeting.id);
      if (meeting.status === 'live') await recordings.syncControl(meeting.id).catch((err) => log.warn({ err }, 'Message de contrôle impossible'));
    }
  });
  client.on(Events.InteractionCreate, (interaction) => void routeInteraction(ctx, interaction));
  client.on(Events.MessageCreate, (message) => {
    hub.onMessage(message).catch((err) => log.warn({ err }, 'Filtrage du post épinglé impossible'));
  });
  client.on(Events.ThreadDelete, (thread) => {
    meetings.onThreadDeleted(thread.id).catch((err) => log.error({ err, threadId: thread.id }, 'Suppression de post non traitée'));
    hub.onThreadDelete(thread.id, thread.guildId).catch((err) => log.error({ err, threadId: thread.id }, 'Recréation du post épinglé impossible'));
  });
  client.on(Events.VoiceStateUpdate, (oldState, newState) => recordings.onVoiceStateUpdate(oldState, newState));
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
    watcher.stop();
    await retention.stop().catch(() => undefined);
    await pipeline.stop().catch(() => undefined);
    await recordings.stopAll().catch((err) => log.error({ err }, 'Arrêt des enregistrements incomplet'));
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
