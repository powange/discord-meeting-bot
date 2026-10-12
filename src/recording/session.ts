import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { EndBehaviorType, type AudioReceiveStream, type VoiceConnection } from '@discordjs/voice';
import { segmentRelativePath } from '../domain/recording.js';
import type { Logger } from '../lib/logger.js';
import { SegmentWriter } from './segmentWriter.js';

/** Durée d'une trame Opus Discord : la fin d'un segment = début du dernier paquet + 20 ms. */
const FRAME_MS = 20;

export interface CapturedSegment {
  userId: string;
  /** Relatifs au début de la session. */
  startMs: number;
  endMs: number;
  packets: number;
  filePath: string;
}

export interface SessionOptions {
  recordingId: string;
  dataDir: string;
  silenceMs: number;
  log: Logger;
  /** Faux pour les bots et les membres ayant le rôle « ne pas m'enregistrer ». */
  shouldRecord(userId: string): boolean;
  onSegment(segment: CapturedSegment): Promise<void>;
}

interface ActiveCapture {
  stream: AudioReceiveStream;
  done: Promise<void>;
}

/**
 * Capture de l'audio d'un vocal : une piste par participant, découpée en prises de parole
 * (un fichier OGG/Opus par prise de parole). Un flux interrompu (DAVE, coupure réseau) ne fait
 * perdre que la prise de parole en cours : la suivante ouvre un nouvel abonnement.
 */
export class RecordingSession {
  readonly startedAt = Date.now();
  private readonly active = new Map<string, ActiveCapture>();
  private stopped = false;

  constructor(
    readonly connection: VoiceConnection,
    private readonly options: SessionOptions,
  ) {
    connection.receiver.speaking.on('start', this.onSpeaking);
  }

  get capturing(): number {
    return this.active.size;
  }

  /** Arrête la capture, finalise les prises de parole en cours et quitte le vocal. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.connection.receiver.speaking.off('start', this.onSpeaking);
    const pending = [...this.active.values()];
    for (const capture of pending) capture.stream.destroy();
    await Promise.allSettled(pending.map((c) => c.done));
    this.connection.destroy();
  }

  private readonly onSpeaking = (userId: string): void => {
    if (this.stopped || this.active.has(userId) || !this.options.shouldRecord(userId)) return;
    this.capture(userId);
  };

  private capture(userId: string): void {
    const { log } = this.options;
    const stream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.options.silenceMs },
    });
    const startMs = Date.now() - this.startedAt;
    const filePath = join(this.options.dataDir, segmentRelativePath(userId, startMs));

    let writer: SegmentWriter;
    try {
      writer = SegmentWriter.open(filePath);
    } catch (err) {
      log.error({ err, userId, filePath }, 'Ouverture du fichier de piste impossible');
      stream.destroy();
      return;
    }

    stream.on('data', (packet: Buffer) => writer.write(packet));
    stream.on('error', (err) => log.warn({ err, userId }, 'Flux audio interrompu (le segment en cours est conservé)'));

    const done = new Promise<void>((resolve) => {
      stream.once('close', () => {
        this.active.delete(userId);
        this.finalize(userId, writer)
          .catch((err) => log.error({ err, userId, filePath }, 'Finalisation de la piste impossible'))
          .finally(resolve);
      });
    });
    this.active.set(userId, { stream, done });
  }

  private async finalize(userId: string, writer: SegmentWriter): Promise<void> {
    const written = await writer.close();
    if (written.packets === 0) {
      await unlink(written.filePath).catch(() => undefined);
      return;
    }
    await this.options.onSegment({
      userId,
      startMs: Math.max(0, written.firstPacketAt - this.startedAt),
      endMs: written.lastPacketAt + FRAME_MS - this.startedAt,
      packets: written.packets,
      filePath: written.filePath,
    });
  }
}
