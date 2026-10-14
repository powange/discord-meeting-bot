import { randomInt } from 'node:crypto';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { finished } from 'node:stream/promises';
import { OPUS_SILENCE_FRAME, PAGE_BOS, PAGE_EOS, oggPage, opusHead, opusPacketSamples, opusTags } from './ogg.js';

/** Paquets par page OGG (≈ 1 s d'audio) : bon compromis taille / perte en cas d'arrêt brutal. */
const PACKETS_PER_PAGE = 50;
/** Au-delà, on ne comble plus (pause anormalement longue dans une même prise de parole). */
const MAX_FILL_FRAMES = 250;
/** Avance de l'horloge sur le fichier tolérée sans silence (gigue réseau). */
const TOLERANCE_MS = 40;

export interface WrittenSegment {
  filePath: string;
  packets: number;
  /** Instant (epoch ms) du premier et du dernier paquet reçu. */
  firstPacketAt: number;
  lastPacketAt: number;
}

/**
 * Écrit une prise de parole dans un fichier OGG/Opus (48 kHz stéréo, sans réencodage).
 * Les courtes pauses (Discord n'envoie rien quand on se tait) sont comblées par des trames de
 * silence quand l'heure réelle écoulée depuis le premier paquet dépasse la durée déjà écrite :
 * la durée du fichier reste fidèle au temps réel, et des paquets retardés qui arrivent en
 * rafale (gigue, boucle d'événements bloquée) ne l'allongent pas.
 */
export class SegmentWriter {
  private readonly serial = randomInt(1, 0xffffffff);
  private sequence = 0;
  private granule = 0n;
  private pending: Buffer[] = [];
  private packets = 0;
  private firstPacketAt = 0;
  /** Origine de l'horloge (décalée quand une pause dépasse le plafond de comblement). */
  private originAt = 0;
  private lastPacketAt = 0;
  /** Erreur d'écriture (disque plein, I/O) : la prise de parole est perdue, pas le processus. */
  private failure: Error | null = null;

  private constructor(
    readonly filePath: string,
    private readonly file: WriteStream,
  ) {
    // Sans écouteur, une erreur d'écriture (ENOSPC…) serait une exception non gérée qui
    // arrêterait le bot et tous les enregistrements en cours.
    file.on('error', (err) => {
      this.failure ??= err;
    });
    this.writePage([opusHead()], PAGE_BOS);
    this.writePage([opusTags()], 0);
  }

  /** Ouverture synchrone : aucun paquet n'est perdu entre le début de la prise de parole et l'écriture. */
  static open(filePath: string): SegmentWriter {
    mkdirSync(dirname(filePath), { recursive: true });
    return new SegmentWriter(filePath, createWriteStream(filePath));
  }

  write(packet: Buffer, at = Date.now()): void {
    if (this.failure) return;
    if (this.packets === 0) {
      this.firstPacketAt = at;
      this.originAt = at;
    } else {
      const ahead = at - this.originAt - this.writtenMs;
      let fill = ahead > TOLERANCE_MS ? Math.round(ahead / 20) : 0;
      if (fill > MAX_FILL_FRAMES) {
        this.originAt += (fill - MAX_FILL_FRAMES) * 20; // pause trop longue : on recale l'horloge
        fill = MAX_FILL_FRAMES;
      }
      for (let i = 0; i < fill; i++) this.push(OPUS_SILENCE_FRAME);
    }
    this.lastPacketAt = at;
    this.packets++;
    this.push(packet);
  }

  /** Vrai après une erreur d'écriture : les paquets suivants sont ignorés. */
  get failed(): boolean {
    return this.failure !== null;
  }

  get packetCount(): number {
    return this.packets;
  }

  /** Durée d'audio écrite (silences compris), en ms. */
  get writtenMs(): number {
    return Number(this.granule) / 48;
  }

  /** Termine le fichier (page de fin) et attend son écriture complète. */
  async close(): Promise<WrittenSegment> {
    if (!this.failure) this.flush(PAGE_EOS);
    this.file.end();
    await finished(this.file).catch((err: Error) => {
      this.failure ??= err;
    });
    if (this.failure) throw new Error(`Écriture de la piste impossible : ${this.failure.message}`, { cause: this.failure });
    return { filePath: this.filePath, packets: this.packets, firstPacketAt: this.firstPacketAt, lastPacketAt: this.lastPacketAt };
  }

  private push(packet: Buffer): void {
    this.granule += BigInt(opusPacketSamples(packet));
    this.pending.push(packet);
    if (this.pending.length >= PACKETS_PER_PAGE) this.flush(0);
  }

  private flush(flags: number): void {
    if (this.pending.length === 0 && !(flags & PAGE_EOS)) return;
    this.writePage(this.pending, flags);
    this.pending = [];
  }

  private writePage(packets: Buffer[], flags: number): void {
    if (this.failure) return;
    const header = flags & PAGE_BOS || this.sequence < 2;
    this.file.write(oggPage(packets, { serial: this.serial, sequence: this.sequence++, granule: header ? 0n : this.granule, flags }));
  }
}
