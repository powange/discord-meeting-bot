import { readdir, rm, statfs } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { schedule, type ScheduledTask } from 'node-cron';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import { mixesToPurge, rawTracksToPurge, unprocessedTracksExpiringSoon } from '../domain/retention.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

export interface PurgeReport {
  rawRecordings: number;
  mixes: number;
  guilds: number;
}

/** Délai avant la suppression des données d'un serveur qui a retiré le bot (retour possible d'ici là). */
export const LEFT_GUILD_DAYS = 30;

/**
 * Rétention des fichiers locaux : purge quotidienne des pistes brutes et des audios complets
 * selon `retention` (par serveur), et alerte quand l'espace libre baisse. Les copies publiées
 * dans Discord ne sont pas concernées.
 */
export class RetentionService {
  private task: ScheduledTask | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly config: AppConfig,
    private readonly log: Logger,
    /** Alerte opérateur (salon d'alertes de tous les serveurs) : espace disque. */
    private readonly alert: (message: string) => Promise<unknown> = async () => undefined,
    /** Alerte d'un serveur (son salon d'alertes) : ses enregistrements bientôt purgés. */
    private readonly guildAlert: (guildId: string, cause: string, message: string) => Promise<unknown> = async () => undefined,
  ) {}

  start(): void {
    // Tous les jours à 4 h 17, heure du conteneur (TZ, Europe/Paris dans la stack), hors des heures de réunion.
    this.task = schedule('17 4 * * *', () => void this.runDaily(), { name: 'retention', noOverlap: true });
    void this.checkDisk();
  }

  async stop(): Promise<void> {
    await this.task?.stop();
  }

  async runDaily(): Promise<void> {
    await this.purge().catch((err) => this.log.error({ err }, 'Purge de rétention en échec'));
    await this.checkDisk();
  }

  async purge(now = new Date()): Promise<PurgeReport> {
    const report: PurgeReport = { rawRecordings: 0, mixes: 0, guilds: 0 };

    const raw = (await this.repos.listRawPurgeCandidates()).map((r) => ({ ...r, days: this.config.guild(r.guildId).retention.rawTracksDays }));
    const toPurge = new Set(rawTracksToPurge(raw, now));
    // Pistes d'un compte rendu en échec supprimées demain : chaque serveur concerné est prévenu
    // (avec les titres), sans partager l'anti-répétition de l'alerte disque.
    const soon = new Set(unprocessedTracksExpiringSoon(raw, now));
    const byGuild = new Map<string, Set<string>>();
    for (const r of raw.filter((x) => soon.has(x.recordingId))) byGuild.set(r.guildId, (byGuild.get(r.guildId) ?? new Set()).add(r.meetingId));
    for (const [guildId, meetingIds] of byGuild) {
      const titles = [];
      for (const id of meetingIds) titles.push((await this.repos.getMeeting(id))?.title ?? id);
      await this.guildAlert(guildId, 'retention', `Les enregistrements de ${titles.map((t) => `« ${t} »`).join(', ')} seront supprimés demain alors que leur compte rendu est en échec : réessayez-le avant si besoin.`).catch(() => undefined);
    }
    for (const r of raw.filter((x) => toPurge.has(x.recordingId))) {
      try {
        // Garde-fou : on ne supprime jamais rien hors du dossier de données.
        if (!this.insideDataDir(r.dataDir)) throw new Error(`chemin hors du dossier de données : ${r.dataDir}`);
        await rm(r.dataDir, { recursive: true, force: true });
        await this.repos.markRecordingPurged(r.recordingId, now);
        report.rawRecordings++;
      } catch (err) {
        this.log.warn({ recordingId: r.recordingId, err: errorMessage(err) }, 'Purge des pistes impossible');
      }
    }

    // Filet de sécurité : mix sans perte d'une réunion close resté sur le disque (arrêt du bot).
    const outputs = await this.repos.listMixOutputs();
    for (const x of outputs.filter((o) => o.meetingStatus !== 'scheduled' && o.meetingStatus !== 'live' && typeof o.output?.master === 'string')) {
      const master = await this.repos.dropMixMaster(x.meetingId);
      if (master && this.insideDataDir(master)) {
        await rm(master, { force: true }).catch(() => undefined);
        await rm(`${master}.json`, { force: true }).catch(() => undefined); // manifeste du mix
      }
    }

    const mixes = (await this.repos.listMixOutputs()).map((x) => ({
      meetingId: x.meetingId,
      output: x.output ?? {},
      file: typeof x.output?.file === 'string' ? x.output.file : null,
      finishedAt: x.finishedAt,
      purged: Boolean(x.output?.purgedAt),
      days: this.config.guild(x.guildId).retention.mixDays,
    }));
    for (const mix of mixesToPurge(mixes, now)) {
      const full = mixes.find((x) => x.meetingId === mix.meetingId)!;
      try {
        const parts = Array.isArray(full.output.parts) ? (full.output.parts as string[]) : [];
        // Le mix sans perte (base des mises à jour) part avec l'audio complet.
        const master = typeof full.output.master === 'string' ? [full.output.master] : [];
        for (const file of [mix.file!, ...parts, ...master, ...master.map((f) => `${f}.json`)]) {
          if (!this.insideDataDir(file)) throw new Error(`chemin hors du dossier de données : ${file}`);
          await rm(file, { force: true });
        }
        await this.repos.markMixPurged(mix.meetingId, full.output, now);
        report.mixes++;
      } catch (err) {
        this.log.warn({ meetingId: mix.meetingId, err: errorMessage(err) }, 'Purge de l’audio complet impossible');
      }
    }

    // Serveurs qui ont retiré le bot depuis plus de LEFT_GUILD_DAYS : tout est supprimé.
    for (const guildId of await this.repos.listGuildsLeftBefore(new Date(now.getTime() - LEFT_GUILD_DAYS * 86_400_000))) {
      try {
        for (const dir of ['recordings', 'meetings']) await rm(join(this.config.dataDir, dir, guildId), { recursive: true, force: true });
        await this.repos.purgeGuild(guildId);
        report.guilds++;
        this.log.info({ guildId }, 'Serveur quitté depuis plus de 30 jours : données supprimées');
      } catch (err) {
        this.log.warn({ guildId, err: errorMessage(err) }, 'Suppression des données d’un serveur quitté impossible');
      }
    }

    if (report.rawRecordings || report.mixes || report.guilds) this.log.info(report, 'Rétention : données purgées');
    return report;
  }

  /**
   * Au démarrage, avant toute reprise de traitement : dossiers temporaires laissés par un arrêt
   * brutal (WAV de transcription, mix en cours).
   */
  async cleanTemp(): Promise<void> {
    await rm(join(this.config.dataDir, 'tmp'), { recursive: true, force: true });
    const meetingsDir = join(this.config.dataDir, 'meetings');
    for (const guild of await readdir(meetingsDir).catch(() => [] as string[])) {
      for (const meeting of await readdir(join(meetingsDir, guild)).catch(() => [] as string[])) {
        await rm(join(meetingsDir, guild, meeting, 'tmp'), { recursive: true, force: true });
      }
    }
  }

  private insideDataDir(path: string): boolean {
    const root = resolve(this.config.dataDir) + sep;
    return resolve(path).startsWith(root);
  }

  /** Espace libre du dossier de données : alerte sous le seuil `diskMinFreeGb`. */
  async checkDisk(): Promise<number | null> {
    try {
      const fs = await statfs(this.config.dataDir);
      const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3;
      if (freeGb < this.config.diskMinFreeGb) {
        const message = `Espace disque faible : ${freeGb.toFixed(1)} Go libres pour les enregistrements (seuil ${this.config.diskMinFreeGb} Go).`;
        this.log.warn({ freeGb }, message);
        await this.alert(message).catch(() => undefined);
      }
      return freeGb;
    } catch (err) {
      this.log.debug({ err: errorMessage(err) }, 'Espace disque non mesurable (dossier de données absent ?)');
      return null;
    }
  }
}
