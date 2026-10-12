import { statfs } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { schedule, type ScheduledTask } from 'node-cron';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import { mixesToPurge, rawTracksToPurge } from '../domain/retention.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

export interface PurgeReport {
  rawRecordings: number;
  mixes: number;
}

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
    /** Alerte opérateur (salon d'alertes) : branchée par la supervision. */
    private readonly alert: (message: string) => Promise<unknown> = async () => undefined,
  ) {}

  start(): void {
    // Tous les jours à 4 h 17 (heure du serveur), hors des heures de réunion.
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
    const report: PurgeReport = { rawRecordings: 0, mixes: 0 };

    const raw = await this.repos.listRawPurgeCandidates();
    const toPurge = new Set(rawTracksToPurge(raw.map((r) => ({ ...r, days: this.config.guild(r.guildId).retention.rawTracksDays })), now));
    for (const r of raw.filter((x) => toPurge.has(x.recordingId))) {
      try {
        await rm(r.dataDir, { recursive: true, force: true });
        await this.repos.markRecordingPurged(r.recordingId, now);
        report.rawRecordings++;
      } catch (err) {
        this.log.warn({ recordingId: r.recordingId, err: errorMessage(err) }, 'Purge des pistes impossible');
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
        await rm(mix.file!, { force: true });
        const parts = Array.isArray(full.output.parts) ? (full.output.parts as string[]) : [];
        for (const part of parts) await rm(part, { force: true });
        await this.repos.markMixPurged(mix.meetingId, full.output, now);
        report.mixes++;
      } catch (err) {
        this.log.warn({ meetingId: mix.meetingId, err: errorMessage(err) }, 'Purge de l’audio complet impossible');
      }
    }

    if (report.rawRecordings || report.mixes) this.log.info(report, 'Rétention : fichiers purgés');
    return report;
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
