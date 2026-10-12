import {
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  type Guild,
} from 'discord.js';
import type { Logger } from '../lib/logger.js';
import { discordErrorCode, errorMessage } from '../lib/errors.js';
import { truncate } from '../lib/text.js';

const UNKNOWN_EVENT = 10070;

export interface EventData {
  title: string;
  description: string;
  startsAt: Date;
  durationMin: number;
  /** Null tant que le salon temporaire n'existe pas : l'événement est alors « externe », avec `location`. */
  voiceChannelId: string | null;
  location: string;
}

/** Lieu de l'événement : le salon vocal, ou un texte tant que le salon n'est pas créé. */
function where(data: EventData) {
  return data.voiceChannelId
    ? { entityType: GuildScheduledEventEntityType.Voice, channel: data.voiceChannelId }
    : { entityType: GuildScheduledEventEntityType.External, entityMetadata: { location: truncate(data.location, 100) } };
}

/**
 * Synchronisation best-effort avec l'événement Discord natif : un échec (permission manquante,
 * événement supprimé à la main…) est loggé mais ne bloque jamais la réunion.
 */
export class ScheduledEvents {
  constructor(private readonly log: Logger) {}

  async create(guild: Guild, data: EventData): Promise<string | null> {
    if (data.startsAt.getTime() <= Date.now()) return null;
    try {
      const event = await guild.scheduledEvents.create({
        name: truncate(data.title, 100),
        description: truncate(data.description, 1000),
        scheduledStartTime: data.startsAt,
        scheduledEndTime: new Date(data.startsAt.getTime() + data.durationMin * 60_000),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        ...where(data),
      });
      return event.id;
    } catch (err) {
      this.log.warn({ guildId: guild.id, err: errorMessage(err) }, 'Création de l’événement Discord impossible');
      return null;
    }
  }

  /** Met à jour l'événement ; le recrée s'il a été supprimé. Renvoie l'id à mémoriser. */
  async update(guild: Guild, eventId: string | null, data: EventData): Promise<string | null> {
    if (!eventId) return this.create(guild, data);
    try {
      await guild.scheduledEvents.edit(eventId, {
        name: truncate(data.title, 100),
        description: truncate(data.description, 1000),
        scheduledStartTime: data.startsAt,
        scheduledEndTime: new Date(data.startsAt.getTime() + data.durationMin * 60_000),
        ...where(data),
      });
      return eventId;
    } catch (err) {
      if (discordErrorCode(err) === UNKNOWN_EVENT) return this.create(guild, data);
      this.log.warn({ guildId: guild.id, eventId, err: errorMessage(err) }, 'Mise à jour de l’événement Discord impossible');
      return eventId;
    }
  }

  async start(guild: Guild, eventId: string | null): Promise<void> {
    await this.setStatus(guild, eventId, [GuildScheduledEventStatus.Active]);
  }

  /** Discord n'autorise « Terminé » que depuis « En cours » : on passe par Active si besoin. */
  async complete(guild: Guild, eventId: string | null): Promise<void> {
    await this.setStatus(guild, eventId, [GuildScheduledEventStatus.Active, GuildScheduledEventStatus.Completed]);
  }

  async cancel(guild: Guild, eventId: string | null): Promise<void> {
    if (!eventId) return;
    const event = await guild.scheduledEvents.fetch(eventId).catch(() => null);
    if (!event) return;
    const target = event.isActive() ? [GuildScheduledEventStatus.Completed] : [GuildScheduledEventStatus.Canceled];
    await this.setStatus(guild, eventId, target);
  }

  private async setStatus(
    guild: Guild,
    eventId: string | null,
    steps: readonly GuildScheduledEventStatus[],
  ): Promise<void> {
    if (!eventId) return;
    for (const status of steps) {
      try {
        const event = await guild.scheduledEvents.fetch(eventId);
        if (event.status === status) continue;
        if (event.isCompleted() || event.isCanceled()) return;
        await event.edit({ status } as Parameters<typeof event.edit>[0]);
      } catch (err) {
        if (discordErrorCode(err) === UNKNOWN_EVENT) return;
        this.log.warn({ guildId: guild.id, eventId, status, err: errorMessage(err) }, 'Changement de statut de l’événement impossible');
        return;
      }
    }
  }
}
