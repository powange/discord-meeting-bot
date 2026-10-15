import { join } from 'node:path';
import { loadConfig } from './config/index.js';
import type { AppContext } from './context.js';
import { createDb, runMigrations } from './db/client.js';
import { acquireInstanceLock, backupBeforeMigrations } from './db/startup.js';
import { Repositories } from './db/repositories.js';
import { createClient, Events } from './discord/client.js';
import { restoreSuppressedEmbeds } from './discord/embedGuard.js';
import { routeInteraction } from './discord/interactions/router.js';
import { registerCommands } from './discord/registerCommands.js';
import { startHealthServer } from './lib/health.js';
import { errorMessage } from './lib/errors.js';
import { createLogger } from './lib/logger.js';
import { buildInfo } from './lib/version.js';
import { configureSecrets, encryptSecret, secretsEnabled } from './lib/secrets.js';
import { PipelineService } from './pipeline/runner.js';
import { createSteps } from './pipeline/steps.js';
import { Scheduler } from './scheduler/index.js';
import { CardService } from './services/cards.js';
import { HubService } from './services/hub.js';
import { AlertService } from './services/alerts.js';
import { MeetingService } from './services/meetings.js';
import { OptoutService } from './services/optouts.js';
import { OwnersService } from './services/owners.js';
import { RetentionService } from './services/retention.js';
import { MeetingWatcher } from './services/meetingWatcher.js';
import { RecordingService } from './services/recordings.js';
import { StorageService } from './services/storage.js';
import { SettingsService } from './services/settings.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const build = buildInfo();
  log.info({ ...build, env: process.env.NODE_ENV ?? 'development' }, 'Démarrage de meeting-recorder');

  const { db, pool } = createDb(config.database.url);
  // Connexion inactive coupée (redémarrage de PostgreSQL) : sans écouteur, l'erreur arrêterait le
  // bot net, enregistrements compris. Le pool en rouvre une à la demande suivante.
  pool.on('error', (err) => log.warn({ err: err.message }, 'Connexion à la base perdue : elle sera rouverte'));
  // Une seule instance par base, puis sauvegarde avant de toucher au schéma.
  let instanceLock = await acquireInstanceLock(pool, log);
  // Verrou d'instance perdu avec sa connexion : repris (une seconde instance ne doit pas pouvoir
  // démarrer), sinon arrêt propre plutôt que de tourner sans protection.
  const watchLock = (lock: typeof instanceLock) => {
    lock.on('error', (err) => {
      log.error({ err: err.message }, 'Connexion du verrou d’instance perdue : reprise du verrou');
      lock.release(err);
      void acquireInstanceLock(pool, log, 120_000).then(
        (next) => {
          instanceLock = next;
          watchLock(next);
          log.info('Verrou d’instance repris');
        },
        (lost) => {
          log.fatal({ err: errorMessage(lost) }, 'Verrou d’instance non repris : arrêt du bot');
          void shutdown('verrou perdu');
        },
      );
    });
  };
  watchLock(instanceLock);
  await backupBeforeMigrations(pool, config.database.url, join(config.dataDir, 'backups'), log);
  await runMigrations(db);
  log.info('Migrations appliquées');

  const client = createClient();
  // Serveur de santé : pour le HEALTHCHECK Docker (production) ; en dev, seulement si HEALTH_PORT est défini.
  const healthPort = process.env.HEALTH_PORT ?? (process.env.NODE_ENV === 'production' ? '3000' : undefined);
  const health = healthPort
    ? startHealthServer(
        Number(healthPort),
        async () => ({
          discord: client.isReady(),
          database: await pool
            .query('select 1')
            .then(() => true)
            .catch(() => false),
          // Un tick manqué pendant 5 minutes une fois Discord prêt : rappels et débuts bloqués.
          scheduler: !client.isReady() || (scheduler.lastTickAt !== null && Date.now() - scheduler.lastTickAt.getTime() < 300_000),
          lastTickAt: scheduler.lastTickAt?.toISOString() ?? null,
        }),
        (err) => log.warn({ err: err.message, port: healthPort }, 'Serveur de santé indisponible (le bot continue)'),
        { ...build },
      )
    : null;
  const repos = new Repositories(db);
  configureSecrets(process.env.APP_SECRET_KEY);
  if (secretsEnabled()) {
    const encrypted = await repos.encryptPlaintextSecrets(encryptSecret);
    if (encrypted > 0) log.info({ count: encrypted }, 'Clés d’API chiffrées en base');
  } else {
    log.warn('APP_SECRET_KEY absente : les clés d’API saisies dans /config sont stockées en clair, et la connexion d’un stockage est désactivée');
  }
  if (config.ai.allowedHosts.length === 0) {
    log.warn('AI_ALLOWED_HOSTS vide : les propriétaires du bot peuvent faire appeler n’importe quelle adresse (serveurs d’IA) ; restreindre au réseau local ou à Tailscale est conseillé');
  }
  const settings = new SettingsService(repos, config);
  const cards = new CardService(client, repos, settings, log);
  const hub = new HubService(client, repos, settings, log);
  const meetings = new MeetingService(config, client, repos, settings, cards, log, (guildId) => hub.refresh(guildId));
  const optouts = new OptoutService(repos, log);
  const recordings = new RecordingService(client, repos, settings, cards, config, log, optouts);
  const alerts = new AlertService(client, repos, log);
  recordings.setAlert((guildId, cause, message) => alerts.guild(guildId, cause, message));
  meetings.setAlert((guildId, cause, message) => alerts.guild(guildId, cause, message));
  const storage = new StorageService(repos, config, log);
  const pipelineDeps = { client, repos, settings, config, log, alerts, storage };
  const pipeline = new PipelineService(pipelineDeps, createSteps(pipelineDeps));
  meetings.hooks = {
    afterStart: (meeting) => recordings.onMeetingStarted(meeting),
    beforeClose: (meetingId) => recordings.onMeetingClosing(meetingId),
    afterEnd: (meetingId) => pipeline.processIfNeeded(meetingId),
  };
  recordings.setOnStopped((meetingId) => pipeline.refresh(meetingId));
  pipeline.setOnPublished((meeting) => {
    cards.refresh(meeting.id, ['card']);
    hub.refresh(meeting.guildId);
    // Bilan de la séance (message à boutons) : il reçoit le lien du compte rendu.
    void recordings.syncControl(meeting.id).catch((err) => log.warn({ meetingId: meeting.id, err }, 'Bilan non mis à jour'));
  });
  const owners = new OwnersService(config.owners);
  const ctx: AppContext = { config, client, log, repos, settings, cards, hub, meetings, recordings, pipeline, owners, optouts, storage };
  const scheduler = new Scheduler(ctx);
  scheduler.setAlert((guildId, cause, message) => alerts.guild(guildId, cause, message));
  const watcher = new MeetingWatcher(client, repos, meetings, config, log);
  const retention = new RetentionService(
    repos,
    config,
    log,
    (message) => alerts.global('disk', message),
    (guildId, cause, message) => alerts.guild(guildId, cause, message),
  );
  await hub.load();

  // Chaque étape d'initialisation est indépendante : une erreur passagère (base, Discord) dans
  // l'une ne doit pas empêcher les autres, surtout pas le scheduler et la surveillance.
  const step = async (name: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      log.error({ err, step: name }, 'Étape de démarrage en échec');
    }
  };
  client.once(Events.ClientReady, async (ready) => {
    // Application connectée en clair : repère immédiatement un token de prod utilisé en dev (ou l'inverse).
    log.info(
      { application: { id: ready.application.id, name: ready.user.username }, user: ready.user.tag, guilds: ready.guilds.cache.size, ...build },
      'Connecté à Discord',
    );
    // Les sessions restées « en cours » sont marquées interrompues avant que la surveillance ne tourne.
    await step('recoverInterrupted', () => recordings.recoverInterrupted());
    // Enregistrement coupé par ce redémarrage : repris tout seul s'il reste du monde dans le vocal.
    await step('resumeRecordings', () => recordings.resumeAfterRestart());
    scheduler.start();
    watcher.start();
    retention.start();
    await step('owners', () => owners.load(ready, log));
    // Ancien rôle « ne pas m'enregistrer » : ses membres sont repris en base, une fois.
    await step('optoutRoles', async () =>
      optouts.migrateRoles(ready, await repos.listOptoutRoles(), (guildId) => repos.updateSettings(guildId, { optoutRoleId: null })),
    );
    await step('registerCommands', () => registerCommands(ready, config.discord.commandGuildIds, log));
    await step('cleanTemp', () => retention.cleanTemp());
    // Bot retiré pendant qu'il était éteint : seulement marqué (suppression dans 30 jours). Pas de
    // révocation ici : un bot démarré par erreur sur une autre base ne doit rien casser d'irréversible.
    await step('leftGuilds', async () => {
      for (const { guildId, leftAt } of await repos.listGuildIds()) {
        if (ready.guilds.cache.has(guildId)) {
          if (leftAt) await repos.markGuildLeft(guildId, null);
        } else if (!leftAt) {
          await repos.markGuildLeft(guildId, new Date());
          log.warn({ guildId }, 'Serveur absent au démarrage : marqué quitté, données supprimées dans 30 jours sauf retour du bot');
        }
      }
    });
    await step('pipelineResume', () => pipeline.resume());
    await step('hubWatchdog', () => hub.startWatchdog());
    // Une nouvelle version peut changer la carte (ex. bouton d'enregistrement) : on régénère celles
    // des réunions ouvertes, sans notification (simple édition des messages existants).
    await step('deletedThreads', async () => {
      const removed = await meetings.checkDeletedThreads();
      if (removed > 0) log.info({ removed }, 'Posts de réunion supprimés pendant l’arrêt du bot : réunions mises à jour');
    });
    await step('refreshCards', async () => {
      for (const meeting of await repos.listOpenMeetings()) {
        cards.refresh(meeting.id);
        if (meeting.status === 'live') await recordings.syncControl(meeting.id).catch((err) => log.warn({ err }, 'Message de contrôle impossible'));
      }
    });
  });
  client.on(Events.InteractionCreate, (interaction) => void routeInteraction(ctx, interaction));
  // Arrivée sur un nouveau serveur : la marche à suivre au propriétaire (message privé), sinon
  // dans le salon système. Sans cela, le bot arrive sans un mot et rien ne marche tant que le
  // forum n'est pas choisi.
  // Bot retiré d'un serveur : accès au stockage révoqué tout de suite, données supprimées 30 jours
  // plus tard (rétention) sauf s'il revient.
  client.on(Events.GuildDelete, (guild) => {
    if (!guild.available) return; // panne Discord, pas un départ
    void (async () => {
      await repos.markGuildLeft(guild.id, new Date());
      await storage.disconnect(guild.id);
      log.info({ guildId: guild.id }, 'Bot retiré du serveur : stockage déconnecté, données supprimées dans 30 jours');
    })().catch((err) => log.warn({ guildId: guild.id, err }, 'Départ du serveur non enregistré'));
  });
  client.on(Events.GuildCreate, (guild) => {
    void repos.markGuildLeft(guild.id, null).catch(() => undefined);
    void (async () => {
      const m = await settings.messages(guild.id);
      const owner = await guild.fetchOwner().catch(() => null);
      const sent = await owner?.send({ content: m.welcome(guild.name), allowedMentions: { parse: [] } }).then(() => true).catch(() => false);
      if (!sent && guild.systemChannel?.isSendable()) await guild.systemChannel.send({ content: m.welcome(guild.name), allowedMentions: { parse: [] } });
      log.info({ guildId: guild.id, dm: sent }, 'Nouveau serveur : message de bienvenue envoyé');
    })().catch((err) => log.warn({ guildId: guild.id, err }, 'Message de bienvenue impossible'));
  });
  client.on(Events.MessageUpdate, (_old, message) => {
    void restoreSuppressedEmbeds(client, message, log);
  });
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
    // Plus de nouveau travail d'abord (le planificateur et la surveillance peuvent encore lancer un
    // enregistrement), puis les enregistrements : fermer proprement les pistes est ce qui ne doit
    // jamais manquer de temps. Le traitement des comptes rendus s'interrompt en parallèle.
    await scheduler.stop().catch(() => undefined);
    await watcher.stop().catch(() => undefined);
    await Promise.allSettled([
      recordings.stopAll().catch((err) => log.error({ err }, 'Arrêt des enregistrements incomplet')),
      pipeline.stop(),
    ]);
    await retention.stop().catch(() => undefined);
    await hub.stopWatchdog().catch(() => undefined);
    await cards.flush().catch(() => undefined);
    await hub.flush().catch(() => undefined);
    await client.destroy();
    health?.close();
    instanceLock.release();
    await pool.end();
    clearTimeout(force);
    log.info('Arrêté');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'Promesse rejetée non gérée'));
  // Dernier filet : on journalise et on s'arrête proprement (pistes fermées) plutôt que de mourir net.
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Exception non gérée : arrêt du bot');
    void shutdown('uncaughtException');
  });

  await client.login(config.discord.token);
}

main().catch((err) => {
  // Le logger n'existe peut-être pas encore (config invalide) : sortie brute.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
