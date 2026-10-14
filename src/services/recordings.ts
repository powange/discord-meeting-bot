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
  type ThreadChannel,
} from 'discord.js';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import type { GuildSettingsRow, MeetingRow } from '../db/schema.js';
import { INTERRUPTIONS, renderLiveControl, renderRecordingControl, type ControlState } from '../discord/embeds/recordingControl.js';
import { consentButton } from '../discord/embeds/meetingManager.js';
import { renderRecordingSummary } from '../discord/embeds/recordingSummary.js';
import { ensureUnarchived } from '../discord/forum.js';
import { displayName } from '../discord/notify.js';
import { fetchThread } from '../discord/threads.js';
import { encode } from '../domain/customId.js';
import { isOpen } from '../domain/meeting.js';
import { ArrivalNotices, RECORDING_NICKNAME } from '../domain/greeting.js';
import type { StopReason } from '../domain/types.js';
import { messages, type Messages } from '../i18n/index.js';
import { freeDiskGb } from '../lib/disk.js';
import { errorMessage, UserError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { RecordingSession } from '../recording/session.js';
import type { CardService } from './cards.js';
import type { OptoutService } from './optouts.js';
import type { SettingsService } from './settings.js';

const JOIN_TIMEOUT_MS = 20_000;
const DISK_CHECK_MS = 10 * 60_000;
const RECONNECT_GRACE_MS = 5_000;
/** Délai au-delà duquel un enregistrement coupé par un redémarrage n'est plus repris tout seul. */
const RESUME_WINDOW_MS = 15 * 60_000;

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
  /** Arrivants prévenus de l'enregistrement (une fois par personne et par session). */
  notices: ArrivalNotices;
  /** Pseudo du bot avant l'enregistrement, restauré à l'arrêt (null = nom par défaut). */
  previousNickname: string | null;
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
    private readonly optouts: OptoutService,
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
      // Les refus expliqués (permissions, vocal occupé, disque…) sont déjà lisibles ; le reste est technique.
      const m = await this.settings.messages(meeting.guildId);
      const reason = err instanceof UserError ? err.message : m.recording.autoStartUnknown;
      this.log.warn({ meetingId, err: errorMessage(err) }, 'Démarrage automatique de l’enregistrement impossible');
      await this.alert(meeting.guildId, 'auto-record', m.recording.autoStartAlert(meeting.title, errorMessage(err))).catch(() => undefined);
      const thread = await fetchThread(this.client, meeting.threadId);
      if (thread) {
        await ensureUnarchived(thread);
        // L'organisateur est prévenu tout de suite, avec de quoi réessayer sans attendre.
        const retry = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(encode({ type: 'rec.start', meetingId })).setLabel(m.recording.retry).setEmoji('🔴').setStyle(ButtonStyle.Primary),
        );
        await thread.send({ content: m.recording.autoStartFailed(meeting.organizerId, reason), components: [retry.toJSON()], allowedMentions: { users: [meeting.organizerId] } });
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
  async start(meetingId: string, by: string | null, resumed = false): Promise<void> {
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
      await this.doStart(meeting, settings, m, by, resumed);
    } catch (err) {
      if (this.active.get(meeting.guildId) === null) this.active.delete(meeting.guildId);
      throw err;
    }
  }

  private async doStart(meeting: MeetingRow, settings: GuildSettingsRow, m: Messages, by: string | null, resumed = false): Promise<void> {
    const guild = await this.client.guilds.fetch(meeting.guildId);
    const channel = meeting.voiceChannelId ? await guild.channels.fetch(meeting.voiceChannelId).catch(() => null) : null;
    if (!channel?.isVoiceBased()) throw new UserError(m.errors.voiceInvalid);
    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    const missing = Object.entries(VOICE_PERMISSIONS)
      .filter(([, flag]) => !perms?.has(flag))
      .map(([name]) => name);
    if (missing.length > 0) throw new UserError(m.errors.voicePermissions(missing.join(', ')));

    // Disque presque plein : refus clair plutôt qu'un enregistrement perdu en cours de route.
    const freeGb = await freeDiskGb(this.config.dataDir);
    if (freeGb !== null && freeGb < this.config.diskMinFreeGb) throw new UserError(m.errors.diskFull(freeGb.toFixed(1)));

    const recCfg = this.config.guild(guild.id).recording;
    await this.optouts.load(guild.id); // refus à jour avant la première prise de parole
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // indispensable pour recevoir l'audio
      selfMute: true,
      decryptionFailureTolerance: recCfg.decryptionFailureTolerance,
      debug: recCfg.debugVoice,
    });
    if (recCfg.debugVoice) connection.on('debug', (message) => this.log.debug({ guildId: guild.id, voice: message }, 'Voix'));
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
    } catch {
      connection.destroy();
      throw new UserError(m.errors.voiceJoinFailed);
    }

    // Connecté au vocal : tout échec à partir d'ici doit l'en faire sortir.
    let started: { recordingId: string; at: Date };
    try {
      started = await this.attachSession(meeting, settings, guild, channel, connection, by);
    } catch (err) {
      connection.destroy();
      throw err;
    }
    const { recordingId, at: now } = started;

    // Présences au démarrage.
    for (const member of channel.members.values()) {
      if (member.user.bot) continue;
      await this.repos.insertPresence({
        recordingId,
        userId: member.id,
        displayName: member.displayName,
        joinedAt: now,
        excluded: this.optouts.isOptedOut(guild.id, member.id),
      });
    }

    this.log.info({ guildId: guild.id, meetingId: meeting.id, recordingId, by }, 'Enregistrement démarré');
    await this.startFirstPoint(meeting.id, now, by).catch((err) => this.warn(meeting.id, 'Premier point de l’ordre du jour non repéré', err));
    await this.announceStart(meeting, m, channel, by, resumed);
    this.cards.refresh(meeting.id, ['card']);
    await this.syncControl(meeting.id);
    this.watchDisk();
  }

  private async attachSession(
    meeting: MeetingRow,
    settings: GuildSettingsRow,
    guild: Guild,
    channel: VoiceBasedChannel,
    connection: VoiceConnection,
    by: string | null,
  ): Promise<{ recordingId: string; at: Date }> {
    const recCfg = this.config.guild(guild.id).recording;
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
      notices: new ArrivalNotices(channel.members.keys()),
      previousNickname: guild.members.me?.nickname ?? null,
    };
    this.active.set(guild.id, entry);
    await this.setNickname(guild, RECORDING_NICKNAME);
    this.watchConnection(entry, connection);
    return { recordingId, at: now };
  }

  /** Pendant une capture : espace disque vérifié toutes les 10 minutes, alerte sous le seuil. */
  private diskTimer: NodeJS.Timeout | null = null;
  private watchDisk(): void {
    if (this.diskTimer) return;
    this.diskTimer = setInterval(() => {
      const guilds = [...this.active.entries()].flatMap(([guildId, a]) => (a ? [guildId] : []));
      if (guilds.length === 0) {
        clearInterval(this.diskTimer!);
        this.diskTimer = null;
        return;
      }
      void freeDiskGb(this.config.dataDir).then(async (freeGb) => {
        if (freeGb === null || freeGb >= this.config.diskMinFreeGb) return;
        for (const guildId of guilds) {
          const m = await this.settings.messages(guildId);
          await this.alert(guildId, 'disk', m.errors.diskLowDuringRecording(freeGb.toFixed(1))).catch(() => undefined);
        }
      });
    }, DISK_CHECK_MS).unref();
  }

  /**
   * Avertissement dans le chat du salon vocal (lu par ceux qui y sont). Dans le post, c'est le
   * message à boutons de l'enregistrement qui le porte.
   */
  private async announceStart(meeting: MeetingRow, m: Messages, channel: VoiceBasedChannel, by: string | null, resumed = false) {
    const byName = by ? await displayName(this.client, meeting.guildId, by) : null;
    if (resumed && channel.isTextBased()) {
      await channel.send({ content: m.recording.resumedNotice, allowedMentions: { parse: [] } }).catch((err) => this.warn(meeting.id, 'Annonce de reprise impossible', err));
    }
    const components = [new ActionRowBuilder<ButtonBuilder>().addComponents(consentButton(m)).toJSON()];
    if (channel.isTextBased()) {
      await channel
        .send({ content: m.recording.announce(byName), components, allowedMentions: { parse: [] } })
        .catch((err) => this.warn(meeting.id, 'Avertissement (chat vocal) impossible', err));
    }
  }

  /** Fin de l'enregistrement annoncée dans le chat du salon vocal (dans le post : message à boutons). */
  private async announceStop(guildId: string, channelId: string, meetingId: string, reason: StopReason, by?: string): Promise<void> {
    const m = await this.settings.messages(guildId);
    const byName = reason === 'manual' && by ? await displayName(this.client, guildId, by) : null;
    const channel = this.client.channels.cache.get(channelId);
    if (channel?.isTextBased() && 'send' in channel) {
      await channel
        .send({ content: m.recording.stopped(byName, m.recording.reasons[reason] ?? reason), allowedMentions: { parse: [] } })
        .catch((err) => this.warn(meetingId, 'Annonce de l’arrêt (chat vocal) impossible', err));
    }
  }

  /**
   * Premier enregistrement de la réunion : la réunion commence par le point 1 de l'ordre du jour,
   * repéré d'office (« Point suivant » propose alors le point 2). Une reprise ne change rien.
   */
  private async startFirstPoint(meetingId: string, at: Date, by: string | null): Promise<void> {
    if ((await this.repos.listMarkers(meetingId)).some((mk) => mk.kind === 'agenda')) return;
    const [first] = await this.repos.listAgenda(meetingId);
    if (!first) return;
    await this.repos.addMarker({ meetingId, kind: 'agenda', at, agendaItemId: first.id, authorId: by ?? this.client.user?.id ?? 'bot' });
  }

  // ---------------------------------------------------------------- arrêt

  /** Arrête l'enregistrement d'une réunion ; renvoie faux s'il n'y en avait pas. `by` : qui l'a arrêté (arrêt manuel). */
  async stop(meetingId: string, reason: StopReason, by?: string): Promise<boolean> {
    const entry = [...this.active.values()].find((a) => a?.meetingId === meetingId);
    if (!entry) return false;
    this.active.delete(entry.guildId); // avant toute attente : un seul arrêt

    await entry.session.stop();
    const guildForNick = this.client.guilds.cache.get(entry.guildId);
    if (guildForNick) await this.setNickname(guildForNick, entry.previousNickname);
    await this.repos.saveCaptureStats(entry.recordingId, entry.session.captureStats()).catch((err) => this.warn(meetingId, 'Statistiques de capture non enregistrées', err));
    const endedAt = new Date();
    await this.repos.closePresence(entry.recordingId, endedAt);
    const interrupted = reason === 'shutdown' || reason === 'disconnected';
    await this.repos.updateRecording(entry.recordingId, {
      endedAt,
      status: interrupted ? 'interrupted' : 'stopped',
      stopReason: reason,
      stoppedBy: reason === 'manual' ? (by ?? null) : null,
    });
    this.log.info({ meetingId, recordingId: entry.recordingId, reason }, 'Enregistrement arrêté');

    // Annonce de l'arrêt, comme celle du démarrage (une interruption a son propre avertissement).
    if (!interrupted) await this.announceStop(entry.guildId, entry.channelId, meetingId, reason, by).catch((err) => this.warn(meetingId, 'Annonce de l’arrêt impossible', err));

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

  /** Pseudo du bot sur le serveur ; sans la permission « Changer le pseudo », on continue sans. */
  private async setNickname(guild: Guild, nickname: string | null): Promise<void> {
    const me = guild.members.me;
    if (!me || me.nickname === nickname) return;
    await me.setNickname(nickname, 'Indicateur d’enregistrement').catch((err) => this.log.debug({ guildId: guild.id, err: errorMessage(err) }, 'Pseudo du bot non modifiable'));
  }

  /** Au démarrage : sessions restées « en cours » après un arrêt brutal du bot. */
  async recoverInterrupted(): Promise<void> {
    // Après un arrêt brutal, le pseudo « 🔴 Enregistrement » a pu rester : on le retire.
    for (const guild of this.client.guilds.cache.values()) {
      if (guild.members.me?.nickname === RECORDING_NICKNAME) await this.setNickname(guild, null);
    }
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

  /**
   * Au démarrage, après recoverInterrupted : un enregistrement coupé par le redémarrage du bot (ou
   * un arrêt brutal) il y a peu est repris tout seul, si la réunion est en cours et qu'il reste
   * quelqu'un dans le vocal. Pas après une déconnexion du vocal : souvent quelqu'un a sorti le
   * bot volontairement. En cas d'échec, le message « interrompu » garde son bouton Reprendre.
   */
  async resumeAfterRestart(now = new Date()): Promise<string[]> {
    const resumed: string[] = [];
    const recent = (await this.repos.listRecordingsByStatus('interrupted')).filter(
      (r) => (r.stopReason === 'shutdown' || r.stopReason === 'crash') && r.endedAt && now.getTime() - r.endedAt.getTime() < RESUME_WINDOW_MS,
    );
    for (const meetingId of new Set(recent.map((r) => r.meetingId))) {
      const meeting = await this.repos.getMeeting(meetingId);
      const sessions = await this.repos.listRecordingsForMeeting(meetingId);
      const last = sessions.at(-1);
      // Seulement si c'est bien la dernière session de la réunion, et que personne n'a déjà relancé.
      if (!meeting || meeting.status !== 'live' || !last || !recent.some((r) => r.id === last.id) || this.active.has(meeting.guildId)) continue;
      const channel = meeting.voiceChannelId ? this.client.channels.cache.get(meeting.voiceChannelId) : undefined;
      const humans = channel?.isVoiceBased() ? channel.members.filter((mb) => !mb.user.bot).size : 0;
      if (humans === 0) continue;
      try {
        await this.start(meetingId, null, true);
        resumed.push(meetingId);
        this.log.info({ meetingId, previous: last.id }, 'Enregistrement repris automatiquement après le redémarrage');
      } catch (err) {
        this.warn(meetingId, 'Reprise automatique de l’enregistrement impossible', err);
      }
    }
    return resumed;
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
        const excluded = this.optouts.isOptedOut(entry.guildId, member.id);
        await this.repos.insertPresence({
          recordingId: entry.recordingId,
          userId: member.id,
          displayName: member.displayName,
          joinedAt: now,
          excluded,
        });
        if (entry.notices.shouldNotify(member.id, !excluded)) {
          const channel = newState.channel;
          const m = messages(settings.locale);
          if (channel?.isTextBased()) {
            await channel
              .send({
                content: m.recording.arrival(member.id),
                components: [new ActionRowBuilder<ButtonBuilder>().addComponents(consentButton(m)).toJSON()],
                allowedMentions: { users: [member.id] },
              })
              .catch((err) => this.warn(entry.meetingId, 'Avertissement de l’arrivant impossible', err));
          }
        }
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
    const thread = await fetchThread(this.client, meeting.threadId);
    if (!thread) return;
    const m = await this.settings.messages(meeting.guildId);
    const sessions = await this.repos.listRecordingsForMeeting(meetingId);
    const active = sessions.find((r) => r.status === 'recording');
    const last = sessions.at(-1);
    const key = !isOpen(meeting.status) ? 'closed' : active ? `rec:${active.id}` : last ? `stopped:${last.id}` : 'idle';
    await this.syncMainControl(meeting, thread, key, m);
    await this.syncLiveControl(meetingId, thread, key, m);
  }

  /** Message à boutons de l'état de l'enregistrement (voir controlState). */
  private async syncMainControl(meeting: MeetingRow, thread: ThreadChannel, key: string, m: Messages): Promise<void> {
    const meetingId = meeting.id;

    const current = meeting.controlMessageId ? await thread.messages.fetch(meeting.controlMessageId).catch(() => null) : null;
    // Même état : le message est mis à jour sur place (point en cours, notes…).
    if (current && (meeting.controlState === key || meeting.controlState === null) && key !== 'closed') {
      await ensureUnarchived(thread);
      await current.edit({ content: null, ...(await this.controlPayload(meeting.guildId, meetingId, key, m)), allowedMentions: { parse: [] } });
      if (meeting.controlState === null) await this.repos.updateMeeting(meetingId, { controlState: key });
      return;
    }
    // Nouvel état : l'ancien message perd ses boutons (« non démarré » est supprimé), un nouveau est publié en bas.
    if (current) {
      await ensureUnarchived(thread);
      if (meeting.controlState === null) await current.edit({ content: m.control.closed, components: [], allowedMentions: { parse: [] } }).catch(() => undefined); // message d'avant cette version
      else if (meeting.controlState === 'idle') await current.delete().catch((err) => this.warn(meetingId, 'Suppression du contrôle impossible', err));
      else await current.edit({ content: null, ...(await this.controlPayload(meeting.guildId, meetingId, meeting.controlState!, m, true)), allowedMentions: { parse: [] } }).catch((err) => this.warn(meetingId, 'Contrôle figé impossible', err));
    }
    if (key === 'closed') {
      if (meeting.controlMessageId) await this.repos.updateMeeting(meetingId, { controlMessageId: null, controlState: 'closed' });
      return;
    }
    if (key === 'idle') {
      // « Non démarré » n'apparaît qu'une fois la réunion « En cours » avec quelqu'un dans le vocal.
      const channel = meeting.voiceChannelId ? this.client.channels.cache.get(meeting.voiceChannelId) : undefined;
      const humans = channel?.isVoiceBased() ? channel.members.filter((mb) => !mb.user.bot).size : 0;
      if (meeting.status !== 'live' || humans === 0) {
        if (current) await this.repos.updateMeeting(meetingId, { controlMessageId: null, controlState: null });
        return;
      }
    }
    await ensureUnarchived(thread);
    const message = await thread.send({ ...(await this.controlPayload(meeting.guildId, meetingId, key, m)), allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications });
    await this.repos.updateMeeting(meetingId, { controlMessageId: message.id, controlState: key });
  }

  /** Contenu du message à boutons pour un état (« idle », « rec:<session> », « stopped:<session> »). */
  private async controlPayload(guildId: string, meetingId: string, key: string, m: Messages, frozen = false) {
    const [kind, recordingId] = key.split(':') as [string, string | undefined];
    const session = recordingId ? (await this.repos.listRecordingsForMeeting(meetingId)).find((r) => r.id === recordingId) : undefined;
    const name = (id: string | null) => (id ? displayName(this.client, guildId, id) : Promise.resolve(null));
    let state: ControlState = { kind: 'idle' };
    if (kind === 'rec' && session) {
      state = { kind: 'rec', startedAt: session.startedAt, endedAt: session.endedAt, startedBy: await name(session.startedBy) };
    } else if (kind === 'stopped' && session) {
      const reason = session.stopReason ?? 'manual';
      state = { kind: 'stopped', stoppedBy: await name(session.stoppedBy), reason: m.recording.reasons[reason] ?? reason, interrupted: INTERRUPTIONS.includes(reason) };
    }
    return renderRecordingControl(meetingId, state, m, frozen);
  }

  /**
   * Suivi de l'ordre du jour, sous l'avertissement, pendant l'enregistrement : mis à jour sur
   * place ; à l'arrêt, il perd ses boutons (le dernier point et les notes restent lisibles).
   */
  private async syncLiveControl(meetingId: string, thread: ThreadChannel, key: string, m: Messages): Promise<void> {
    const meeting = (await this.repos.getMeeting(meetingId))!;
    const recording = key.startsWith('rec:');
    if (!recording && !meeting.liveMessageId) return;
    const live = { agenda: (await this.repos.listAgenda(meetingId)).map((a) => ({ id: a.id, title: a.title })), markers: await this.repos.listMarkers(meetingId) };
    const payload = { ...renderLiveControl(meetingId, live, m, !recording), allowedMentions: { parse: [] as [] } };
    const current = meeting.liveMessageId ? await thread.messages.fetch(meeting.liveMessageId).catch(() => null) : null;
    await ensureUnarchived(thread);
    if (current) {
      await current.edit({ content: null, ...payload }).catch((err) => this.warn(meetingId, 'Suivi de l’ordre du jour non mis à jour', err));
      if (!recording) await this.repos.updateMeeting(meetingId, { liveMessageId: null });
      return;
    }
    if (!recording) {
      await this.repos.updateMeeting(meetingId, { liveMessageId: null });
      return;
    }
    const message = await thread.send({ ...payload, flags: MessageFlags.SuppressNotifications });
    await this.repos.updateMeeting(meetingId, { liveMessageId: message.id });
  }

  private shouldRecord(guild: Guild, settings: GuildSettingsRow, userId: string): boolean {
    const member = guild.members.cache.get(userId);
    if (!member) return !this.optouts.isOptedOut(guild.id, userId); // normalement en cache (présent dans le vocal)
    return !member.user.bot && !this.optouts.isOptedOut(guild.id, userId);
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

    const [presence, segments, rsvps, recording, capture] = await Promise.all([
      this.repos.listPresence(recordingId),
      this.repos.listSegments(recordingId),
      this.repos.listRsvps(meetingId),
      this.repos.getRecording(recordingId),
      this.repos.listCaptureStats(recordingId),
    ]);
    if (!recording) return;
    const container = renderRecordingSummary(
      {
        reason: m.recording.reasons[reason] ?? reason,
        startedAt: recording.startedAt,
        endedAt: recording.endedAt ?? new Date(),
        segments,
        presence,
        rsvps,
        capture,
      },
      { meetingTitle: meeting.title, interrupted },
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
