import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { entersState, joinVoiceChannel, VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import type { GuildSettingsRow, MeetingRow } from '../db/schema.js';
import { ensureUnarchived } from '../discord/forum.js';
import { displayName } from '../discord/notify.js';
import { fetchThread } from '../discord/threads.js';
import { encode } from '../domain/customId.js';
import { isOpen } from '../domain/meeting.js';
import { attendanceReport, shouldStopForEmpty } from '../domain/recording.js';
import type { StopReason } from '../domain/types.js';
import { messages, type Messages } from '../i18n/index.js';
import { errorMessage, UserError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { joinLinesWithin } from '../lib/text.js';
import { RecordingSession } from '../recording/session.js';
import type { CardService } from './cards.js';
import type { SettingsService } from './settings.js';

const JOIN_TIMEOUT_MS = 20_000;
const RECONNECT_GRACE_MS = 5_000;
const WATCH_INTERVAL_MS = 15_000;

const VOICE_PERMISSIONS = {
  ViewChannel: PermissionFlagsBits.ViewChannel,
  Connect: PermissionFlagsBits.Connect,
} as const;

interface ActiveRecording {
  recordingId: string;
  meetingId: string;
  guildId: string;
  channelId: string;
  meetingStartsAt: Date;
  session: RecordingSession;
  lastHumanAt: Date | null;
  watch: NodeJS.Timeout;
}

/** Fin de réunion déclenchée par l'enregistrement (vocal vide). Fourni par le service des réunions. */
export type EndMeeting = (meetingId: string) => Promise<unknown>;

/**
 * Enregistrement des réunions : le bot rejoint le vocal (un seul vocal par serveur à la fois,
 * contrainte Discord), capture une piste par participant et note les présences réelles.
 */
export class RecordingService {
  /** Par serveur. Une entrée `null` = démarrage en cours (évite deux démarrages simultanés). */
  private readonly active = new Map<string, ActiveRecording | null>();
  private endMeeting: EndMeeting = async () => undefined;

  constructor(
    private readonly client: Client,
    private readonly repos: Repositories,
    private readonly settings: SettingsService,
    private readonly cards: CardService,
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {}

  setEndMeeting(fn: EndMeeting): void {
    this.endMeeting = fn;
  }

  /**
   * Démarrage automatique (échéance « record_start » ou passage « En cours ») : sans effet si
   * l'option est désactivée ou si l'enregistrement tourne déjà ; un échec est signalé dans le post.
   */
  async autoStart(meetingId: string): Promise<void> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting?.autoRecord || !isOpen(meeting.status) || this.isRecording(meetingId)) return;
    try {
      await this.start(meetingId, null);
    } catch (err) {
      const reason = err instanceof UserError ? err.message : errorMessage(err);
      this.log.warn({ meetingId, err: reason }, 'Démarrage automatique de l’enregistrement impossible');
      const thread = await fetchThread(this.client, meeting.threadId);
      const m = await this.settings.messages(meeting.guildId);
      if (thread) {
        await ensureUnarchived(thread);
        await thread.send({ content: m.recording.autoStartFailed(reason), allowedMentions: { parse: [] } });
      }
    }
  }

  isRecording(meetingId: string): boolean {
    return [...this.active.values()].some((a) => a?.meetingId === meetingId);
  }

  // ---------------------------------------------------------------- démarrage

  /** Démarre l'enregistrement d'une réunion. `by` = null pour un démarrage automatique. */
  async start(meetingId: string, by: string | null): Promise<void> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting) throw new Error(`Réunion ${meetingId} introuvable`);
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
    if (this.active.has(meeting.guildId)) {
      throw new UserError(this.isRecording(meetingId) ? m.errors.alreadyRecording : m.errors.recordingBusy);
    }

    this.active.set(meeting.guildId, null); // réservation
    try {
      await this.doStart(meeting, settings, m, by);
    } catch (err) {
      if (this.active.get(meeting.guildId) === null) this.active.delete(meeting.guildId);
      throw err;
    }
  }

  private async doStart(meeting: MeetingRow, settings: GuildSettingsRow, m: Messages, by: string | null): Promise<void> {
    const guild = await this.client.guilds.fetch(meeting.guildId);
    const channel = await guild.channels.fetch(meeting.voiceChannelId).catch(() => null);
    if (!channel?.isVoiceBased()) throw new UserError(m.errors.voiceInvalid);
    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    const missing = Object.entries(VOICE_PERMISSIONS)
      .filter(([, flag]) => !perms?.has(flag))
      .map(([name]) => name);
    if (missing.length > 0) throw new UserError(m.errors.voicePermissions(missing.join(', ')));

    const recCfg = this.config.guild(guild.id).recording;
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // indispensable pour recevoir l'audio
      selfMute: true,
      decryptionFailureTolerance: recCfg.decryptionFailureTolerance,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
    } catch {
      connection.destroy();
      throw new UserError(m.errors.voiceJoinFailed);
    }

    const recordingId = randomUUID();
    const dataDir = join(this.config.dataDir, 'recordings', guild.id, recordingId);
    const now = new Date();
    await this.repos.insertRecording({
      id: recordingId,
      meetingId: meeting.id,
      guildId: guild.id,
      voiceChannelId: channel.id,
      startedBy: by,
      startedAt: now,
      dataDir,
    });

    const session = new RecordingSession(connection, {
      recordingId,
      dataDir,
      silenceMs: recCfg.silenceMs,
      log: this.log.child({ recordingId, meetingId: meeting.id }),
      shouldRecord: (userId) => this.shouldRecord(guild, settings, userId),
      onSegment: (segment) => this.repos.insertSegment({ recordingId, ...segment }),
    });

    const entry: ActiveRecording = {
      recordingId,
      meetingId: meeting.id,
      guildId: guild.id,
      channelId: channel.id,
      meetingStartsAt: meeting.startsAt,
      session,
      lastHumanAt: null,
      watch: setInterval(() => void this.watch(guild.id), WATCH_INTERVAL_MS),
    };
    this.active.set(guild.id, entry);
    this.watchConnection(entry, connection);

    // Présences au démarrage.
    for (const member of channel.members.values()) {
      if (member.user.bot) continue;
      entry.lastHumanAt = now;
      await this.repos.insertPresence({
        recordingId,
        userId: member.id,
        displayName: member.displayName,
        joinedAt: now,
        excluded: this.isOptedOut(settings, member.roles.cache.keys()),
      });
    }

    this.log.info({ guildId: guild.id, meetingId: meeting.id, recordingId, by }, 'Enregistrement démarré');
    await this.announceStart(meeting, settings, m, channel, by);
    this.cards.refresh(meeting.id, ['card']);
  }

  /** Avertissement RGPD dans le post et dans le chat du salon vocal (lu par ceux qui y sont). */
  private async announceStart(meeting: MeetingRow, settings: GuildSettingsRow, m: Messages, channel: VoiceBasedChannel, by: string | null) {
    const optout = settings.optoutRoleId ? (channel.guild.roles.cache.get(settings.optoutRoleId)?.name ?? null) : null;
    const byName = by ? await displayName(this.client, meeting.guildId, by) : null;
    const text = `${m.recording.started(byName)}\n${m.recording.warning(optout)}`;
    const thread = await fetchThread(this.client, meeting.threadId);
    if (thread) {
      await ensureUnarchived(thread);
      await thread.send({ content: text, allowedMentions: { parse: [] } }).catch((err) => this.warn(meeting.id, 'Avertissement (post) impossible', err));
    }
    if (channel.isTextBased()) {
      await channel.send({ content: text, allowedMentions: { parse: [] } }).catch((err) => this.warn(meeting.id, 'Avertissement (chat vocal) impossible', err));
    }
  }

  // ---------------------------------------------------------------- arrêt

  /** Arrête l'enregistrement d'une réunion ; renvoie faux s'il n'y en avait pas. */
  async stop(meetingId: string, reason: StopReason): Promise<boolean> {
    const entry = [...this.active.values()].find((a) => a?.meetingId === meetingId);
    if (!entry) return false;
    this.active.delete(entry.guildId); // avant toute attente : un seul arrêt
    clearInterval(entry.watch);

    await entry.session.stop();
    const endedAt = new Date();
    await this.repos.closePresence(entry.recordingId, endedAt);
    const interrupted = reason === 'shutdown' || reason === 'disconnected';
    await this.repos.updateRecording(entry.recordingId, {
      endedAt,
      status: interrupted ? 'interrupted' : 'stopped',
      stopReason: reason,
    });
    this.log.info({ meetingId, recordingId: entry.recordingId, reason }, 'Enregistrement arrêté');

    await this.postSummary(entry.recordingId, meetingId, reason, interrupted).catch((err) => this.warn(meetingId, 'Bilan impossible', err));
    if (reason !== 'shutdown') this.cards.refresh(meetingId, ['card']);
    return true;
  }

  /** Arrêt propre de tous les enregistrements (arrêt du bot). */
  async stopAll(): Promise<void> {
    const meetingIds = [...this.active.values()].flatMap((a) => (a ? [a.meetingId] : []));
    await Promise.allSettled(meetingIds.map((id) => this.stop(id, 'shutdown')));
  }

  /** Au démarrage : sessions restées « en cours » après un arrêt brutal du bot. */
  async recoverInterrupted(): Promise<void> {
    for (const rec of await this.repos.listRecordingsByStatus('recording')) {
      const at = new Date();
      await this.repos.closePresence(rec.id, at);
      await this.repos.updateRecording(rec.id, { status: 'interrupted', stopReason: 'crash', endedAt: at });
      this.log.warn({ recordingId: rec.id, meetingId: rec.meetingId }, 'Enregistrement interrompu par un arrêt inattendu');
      await this.postSummary(rec.id, rec.meetingId, 'crash', true).catch((err) => this.warn(rec.meetingId, 'Bilan impossible', err));
      this.cards.refresh(rec.meetingId, ['card']);
    }
  }

  // ---------------------------------------------------------------- présences et surveillance

  onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const entry = this.active.get(newState.guild.id);
    if (!entry) return;
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;
    const joined = oldState.channelId !== entry.channelId && newState.channelId === entry.channelId;
    const left = oldState.channelId === entry.channelId && newState.channelId !== entry.channelId;
    const now = new Date();
    if (joined || left) entry.lastHumanAt = now;

    void (async () => {
      if (joined) {
        const settings = await this.settings.get(entry.guildId);
        await this.repos.insertPresence({
          recordingId: entry.recordingId,
          userId: member.id,
          displayName: member.displayName,
          joinedAt: now,
          excluded: this.isOptedOut(settings, member.roles.cache.keys()),
        });
      } else if (left) {
        await this.repos.closePresence(entry.recordingId, now, member.id);
      }
    })().catch((err) => this.warn(entry.meetingId, 'Mise à jour de présence impossible', err));
  }

  /** Vocal vide depuis trop longtemps : fin de l'enregistrement et de la réunion. */
  private async watch(guildId: string): Promise<void> {
    const entry = this.active.get(guildId);
    if (!entry) return;
    const channel = this.client.channels.cache.get(entry.channelId);
    const humans = channel?.isVoiceBased() ? channel.members.filter((mb) => !mb.user.bot).size : 0;
    const now = new Date();
    if (humans > 0) entry.lastHumanAt = now;
    const graceMin = this.config.guild(guildId).recording.endWhenEmptyMin;
    if (!shouldStopForEmpty({ humansPresent: humans, lastHumanAt: entry.lastHumanAt, meetingStartsAt: entry.meetingStartsAt, now, graceMin })) return;

    this.log.info({ meetingId: entry.meetingId, graceMin }, 'Vocal vide : fin de la réunion');
    await this.stop(entry.meetingId, 'empty');
    await this.endMeeting(entry.meetingId).catch((err) => this.warn(entry.meetingId, 'Clôture de la réunion impossible', err));
  }

  /** Coupure réseau : on laisse quelques secondes à la reconnexion, sinon arrêt (reprise possible). */
  private watchConnection(entry: ActiveRecording, connection: VoiceConnection): void {
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void (async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_GRACE_MS),
            entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_GRACE_MS),
          ]);
        } catch {
          if (this.active.get(entry.guildId) === entry) await this.stop(entry.meetingId, 'disconnected');
        }
      })().catch((err) => this.warn(entry.meetingId, 'Gestion de la déconnexion impossible', err));
    });
  }

  private shouldRecord(guild: Guild, settings: GuildSettingsRow, userId: string): boolean {
    const member = guild.members.cache.get(userId);
    if (!member) return true; // présent dans le vocal donc normalement en cache ; par défaut on enregistre
    return !member.user.bot && !this.isOptedOut(settings, member.roles.cache.keys());
  }

  private isOptedOut(settings: GuildSettingsRow, roleIds: Iterable<string>): boolean {
    if (!settings.optoutRoleId) return false;
    for (const id of roleIds) if (id === settings.optoutRoleId) return true;
    return false;
  }

  // ---------------------------------------------------------------- bilan

  private async postSummary(recordingId: string, meetingId: string, reason: StopReason | 'crash', interrupted: boolean): Promise<void> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting) return;
    const thread = await fetchThread(this.client, meeting.threadId);
    if (!thread) return;
    const m = await this.settings.messages(meeting.guildId);

    const [presence, segments, rsvps, recording] = await Promise.all([
      this.repos.listPresence(recordingId),
      this.repos.listSegments(recordingId),
      this.repos.listRsvps(meetingId),
      this.repos.getRecording(recordingId),
    ]);
    const endedAt = recording?.endedAt ?? new Date();
    const report = attendanceReport(rsvps, presence, endedAt);
    const durationMin = recording ? Math.round((endedAt.getTime() - recording.startedAt.getTime()) / 60_000) : 0;
    const speakers = new Set(segments.map((s) => s.userId)).size;

    const list = (ids: string[]) => joinLinesWithin(ids.map((id) => `<@${id}>`), 900, m.card.more, ' ');
    const lines = [`**${m.recording.summaryTitle(m.recording.reasons[reason] ?? reason)}**`, m.recording.summaryLine(m.card.minutes(durationMin), speakers, segments.length)];
    if (report.came.length) lines.push(`✅ ${m.recording.came} : ${list(report.came)}`);
    if (report.noShow.length) lines.push(`❌ ${m.recording.noShow} : ${list(report.noShow)}`);
    if (report.unannounced.length) lines.push(`➕ ${m.recording.unannounced} : ${list(report.unannounced)}`);
    if (report.notRecorded.length) lines.push(`🔇 ${m.recording.notRecorded} : ${list(report.notRecorded)}`);
    if (interrupted) lines.push(m.recording.interrupted);

    const components =
      interrupted && isOpen(meeting.status)
        ? [
            new ActionRowBuilder<ButtonBuilder>()
              .addComponents(
                new ButtonBuilder()
                  .setCustomId(encode({ type: 'rec.start', meetingId }))
                  .setLabel(m.buttons.resumeRecording)
                  .setEmoji('🔴')
                  .setStyle(ButtonStyle.Primary),
              )
              .toJSON(),
          ]
        : [];

    await ensureUnarchived(thread);
    await thread.send({
      content: lines.join('\n').slice(0, 2000),
      components,
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressNotifications,
    });
  }

  private warn(meetingId: string, msg: string, err: unknown): void {
    this.log.warn({ meetingId, err: errorMessage(err) }, msg);
  }
}
