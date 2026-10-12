import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { entersState, joinVoiceChannel, VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import {
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
import { renderRecordingControl } from '../discord/embeds/recordingControl.js';
import { renderRecordingSummary } from '../discord/embeds/recordingSummary.js';
import { ensureUnarchived } from '../discord/forum.js';
import { displayName } from '../discord/notify.js';
import { fetchThread } from '../discord/threads.js';
import { encode } from '../domain/customId.js';
import { isOpen } from '../domain/meeting.js';
import type { StopReason } from '../domain/types.js';
import { messages, type Messages } from '../i18n/index.js';
import { errorMessage, UserError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { RecordingSession } from '../recording/session.js';
import type { CardService } from './cards.js';
import type { SettingsService } from './settings.js';

const JOIN_TIMEOUT_MS = 20_000;
const RECONNECT_GRACE_MS = 5_000;

const VOICE_PERMISSIONS = {
  ViewChannel: PermissionFlagsBits.ViewChannel,
  Connect: PermissionFlagsBits.Connect,
} as const;

interface ActiveRecording {
  recordingId: string;
  meetingId: string;
  guildId: string;
  channelId: string;
  session: RecordingSession;
}

/**
 * Enregistrement des réunions : le bot rejoint le vocal (un seul vocal par serveur à la fois,
 * contrainte Discord), capture une piste par participant et note les présences réelles.
 * La fin sur vocal vide est gérée par MeetingWatcher (clôture de la réunion → arrêt ici).
 */
export class RecordingService {
  /** Par serveur. Une entrée `null` = démarrage en cours (évite deux démarrages simultanés). */
  private readonly active = new Map<string, ActiveRecording | null>();
  /** Appelé à la fin d'un enregistrement (pas après une coupure : une reprise est probable). */
  private onStopped: (meetingId: string) => Promise<unknown> = async () => undefined;
  /** Mises à jour du message de contrôle, sérialisées par réunion (pas de double publication). */
  private readonly controlQueue = new Map<string, Promise<void>>();

  constructor(
    private readonly client: Client,
    private readonly repos: Repositories,
    private readonly settings: SettingsService,
    private readonly cards: CardService,
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {}

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

  private alert: (guildId: string, cause: string, message: string) => Promise<unknown> = async () => undefined;

  setAlert(fn: (guildId: string, cause: string, message: string) => Promise<unknown>): void {
    this.alert = fn;
  }

  setOnStopped(fn: (meetingId: string) => Promise<unknown>): void {
    this.onStopped = fn;
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
      session,
    };
    this.active.set(guild.id, entry);
    this.watchConnection(entry, connection);

    // Présences au démarrage.
    for (const member of channel.members.values()) {
      if (member.user.bot) continue;
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
    await this.syncControl(meeting.id);
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
    if (reason !== 'shutdown') {
      this.cards.refresh(meetingId, ['card']);
      await this.syncControl(meetingId).catch((err) => this.warn(meetingId, 'Mise à jour du contrôle impossible', err));
    }
    if (!interrupted) await this.onStopped(meetingId).catch((err) => this.warn(meetingId, 'Lancement du compte rendu impossible', err));
    if (reason === 'disconnected') await this.alertInterrupted(meetingId, reason);
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
      await this.syncControl(rec.meetingId).catch((err) => this.warn(rec.meetingId, 'Mise à jour du contrôle impossible', err));
      await this.alertInterrupted(rec.meetingId, 'crash');
    }
  }

  // ---------------------------------------------------------------- présences et surveillance

  onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const arrived = newState.channelId && oldState.channelId !== newState.channelId && !newState.member?.user.bot;
    if (arrived) {
      void this.offerControl(newState.guild.id, newState.channelId!).catch((err) =>
        this.log.warn({ guildId: newState.guild.id, err: errorMessage(err) }, 'Message de contrôle impossible'),
      );
    }
    const entry = this.active.get(newState.guild.id);
    if (!entry) return;
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;
    const joined = oldState.channelId !== entry.channelId && newState.channelId === entry.channelId;
    const left = oldState.channelId === entry.channelId && newState.channelId !== entry.channelId;
    const now = new Date();

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

  // ---------------------------------------------------------------- message de contrôle

  /** Réunion passée « En cours » : démarrage auto éventuel, et contrôle si quelqu'un est déjà là. */
  async onMeetingStarted(meeting: MeetingRow): Promise<void> {
    await this.autoStart(meeting.id);
    await this.syncControl(meeting.id);
  }

  /** Réunion close ou annulée : arrêt de l'enregistrement et contrôle désactivé. */
  async onMeetingClosing(meetingId: string): Promise<void> {
    await this.stop(meetingId, 'meeting_end');
    await this.syncControl(meetingId);
  }

  /** Quelqu'un rejoint un vocal : s'il s'agit de celui d'une réunion en cours, on propose l'enregistrement. */
  private async offerControl(guildId: string, channelId: string): Promise<void> {
    const live = await this.repos.listMeetings(guildId, ['live']);
    for (const meeting of live) if (meeting.voiceChannelId === channelId && !meeting.controlMessageId) await this.syncControl(meeting.id);
  }

  /**
   * Publie ou met à jour le message de contrôle. Il n'apparaît qu'une fois la réunion « En
   * cours » avec au moins une personne dans le vocal (ou si un enregistrement auto a démarré
   * plus tôt) ; ensuite il suit l'état de l'enregistrement, puis la clôture.
   */
  syncControl(meetingId: string): Promise<void> {
    const previous = this.controlQueue.get(meetingId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.doSyncControl(meetingId));
    this.controlQueue.set(meetingId, next);
    void next.finally(() => this.controlQueue.get(meetingId) === next && this.controlQueue.delete(meetingId)).catch(() => undefined);
    return next;
  }

  private async doSyncControl(meetingId: string): Promise<void> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting?.threadId) return;
    const recording = await this.repos.getActiveRecording(meetingId);
    const m = await this.settings.messages(meeting.guildId);
    const payload = renderRecordingControl(meeting, recording?.startedAt ?? null, m);
    const thread = await fetchThread(this.client, meeting.threadId);
    if (!thread) return;

    if (meeting.controlMessageId) {
      const message = await thread.messages.fetch(meeting.controlMessageId).catch(() => null);
      if (message) {
        await ensureUnarchived(thread);
        await message.edit({ ...payload, allowedMentions: { parse: [] } });
        return;
      }
      // Supprimé à la main : on le republie si c'est encore utile.
    }

    if (!isOpen(meeting.status)) return;
    const channel = this.client.channels.cache.get(meeting.voiceChannelId);
    const humans = channel?.isVoiceBased() ? channel.members.filter((mb) => !mb.user.bot).size : 0;
    const wanted = recording !== undefined || (meeting.status === 'live' && humans > 0);
    if (!wanted) return;
    await ensureUnarchived(thread);
    const message = await thread.send({ ...payload, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications });
    await this.repos.updateMeeting(meetingId, { controlMessageId: message.id });
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

  private async alertInterrupted(meetingId: string, reason: string): Promise<void> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting) return;
    const m = await this.settings.messages(meeting.guildId);
    const url = meeting.threadId ? `https://discord.com/channels/${meeting.guildId}/${meeting.threadId}` : '';
    await this.alert(meeting.guildId, `recording:${meetingId}`, m.alerts.recordingInterrupted(meeting.title, m.recording.reasons[reason] ?? reason, url)).catch(() => undefined);
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
    if (!recording) return;
    const resumeButton =
      interrupted && isOpen(meeting.status)
        ? new ButtonBuilder()
            .setCustomId(encode({ type: 'rec.start', meetingId }))
            .setLabel(m.buttons.resumeRecording)
            .setEmoji('🔴')
            .setStyle(ButtonStyle.Primary)
        : undefined;
    const container = renderRecordingSummary(
      {
        reason: m.recording.reasons[reason] ?? reason,
        startedAt: recording.startedAt,
        endedAt: recording.endedAt ?? new Date(),
        segments,
        presence,
        rsvps,
      },
      { meetingTitle: meeting.title, interrupted, ...(resumeButton ? { resumeButton } : {}) },
      m,
    );

    await ensureUnarchived(thread);
    await thread.send({
      components: [container],
      allowedMentions: { parse: [] },
      flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
    });
  }

  private warn(meetingId: string, msg: string, err: unknown): void {
    this.log.warn({ meetingId, err: errorMessage(err) }, msg);
  }
}
