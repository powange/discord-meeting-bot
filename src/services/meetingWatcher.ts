import type { Client } from 'discord.js';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import { shouldCloseForEmpty } from '../domain/meeting.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { MeetingService } from './meetings.js';

const CHECK_INTERVAL_MS = 30_000;

/**
 * Clôture automatique des réunions en cours, uniquement sur vocal vide : une réunion qui dépasse
 * l'heure prévue n'est jamais coupée tant que quelqu'un est dans le vocal. Indépendant de
 * l'enregistrement (la clôture arrête l'enregistrement, s'il tourne).
 */
export class MeetingWatcher {
  /** Dernière présence humaine vue, par réunion (mémoire : perdue au redémarrage). */
  private readonly lastHumanAt = new Map<string, Date>();
  private readonly startedAt = new Date();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly client: Client,
    private readonly repos: Repositories,
    private readonly meetings: MeetingService,
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const live = await this.repos.listOpenMeetings().then((rows) => rows.filter((r) => r.status === 'live'));
      const liveIds = new Set(live.map((r) => r.id));
      for (const id of this.lastHumanAt.keys()) if (!liveIds.has(id)) this.lastHumanAt.delete(id);

      for (const meeting of live) {
        if (!meeting.voiceChannelId) {
          // Création du salon temporaire en échec au début : on réessaie ; sans salon, la réunion
          // est close après la fin prévue (personne n'a pu s'y retrouver).
          const fixed = await this.meetings.ensureVoice(meeting.id).catch(() => undefined);
          if (fixed?.voiceChannelId) continue;
          const plannedEnd = new Date(meeting.startsAt.getTime() + meeting.durationMin * 60_000);
          const graceMin = this.config.guild(meeting.guildId).recording.endWhenEmptyMin;
          if (shouldCloseForEmpty({ humansPresent: 0, lastHumanAt: null, plannedEnd, now, graceMin })) {
            this.log.info({ meetingId: meeting.id }, 'Réunion sans salon vocal : clôture après la fin prévue');
            await this.meetings.end(meeting.id, null).catch((err) => this.log.warn({ meetingId: meeting.id, err: errorMessage(err) }, 'Clôture impossible'));
          }
          continue;
        }
        const channel = this.client.channels.cache.get(meeting.voiceChannelId);
        const humans = channel?.isVoiceBased() ? channel.members.filter((mb) => !mb.user.bot).size : 0;
        if (humans > 0) {
          this.lastHumanAt.set(meeting.id, now);
          continue;
        }
        const plannedEnd = new Date(meeting.startsAt.getTime() + meeting.durationMin * 60_000);
        // Après un redémarrage, on ignore qui était là avant : on ne compte qu'à partir du démarrage du bot.
        const lastSeen = this.lastHumanAt.get(meeting.id) ?? (meeting.startedAt && meeting.startedAt < this.startedAt ? this.startedAt : null);
        const graceMin = this.config.guild(meeting.guildId).recording.endWhenEmptyMin;
        if (!shouldCloseForEmpty({ humansPresent: 0, lastHumanAt: lastSeen, plannedEnd, now, graceMin })) continue;

        this.log.info({ meetingId: meeting.id, graceMin }, 'Vocal vide : clôture de la réunion');
        this.lastHumanAt.delete(meeting.id);
        await this.meetings.end(meeting.id, null).catch((err) => this.log.warn({ meetingId: meeting.id, err: errorMessage(err) }, 'Clôture impossible'));
      }

      // Salons temporaires des réunions finies : supprimés dès qu'ils sont vides.
      for (const meeting of await this.repos.listTemporaryVoicesToDelete()) {
        await this.meetings
          .deleteTemporaryVoice(meeting)
          .catch((err) => this.log.warn({ meetingId: meeting.id, err: errorMessage(err) }, 'Suppression du salon temporaire impossible'));
      }
    } catch (err) {
      this.log.error({ err }, 'Surveillance des réunions en échec');
    } finally {
      this.running = false;
    }
  }
}
