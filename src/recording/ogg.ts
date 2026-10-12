/**
 * Muxer OGG/Opus minimal (RFC 3533 + RFC 7845), sans dépendance native : les paquets Opus reçus
 * de Discord sont encapsulés tels quels (aucun réencodage, 48 kHz stéréo).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** CRC32 Ogg : polynôme 0x04C11DB7, non réfléchi, valeur initiale 0, sans XOR final. */
export function oggCrc(buffer: Uint8Array): number {
  let crc = 0;
  for (const byte of buffer) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

/** Trame Opus de silence (20 ms, CELT) utilisée pour combler les pauses. */
export const OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
export const SAMPLES_PER_20MS = 960;

const FRAME_SAMPLES_BY_CONFIG = [
  480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880, // SILK NB/MB/WB : 10, 20, 40, 60 ms
  480, 960, 480, 960, // hybride SWB/FB : 10, 20 ms
  120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, // CELT : 2.5, 5, 10, 20 ms
];

/** Nombre d'échantillons (à 48 kHz) d'un paquet Opus, d'après son octet TOC (RFC 6716 §3.1). */
export function opusPacketSamples(packet: Uint8Array): number {
  const toc = packet[0];
  if (toc === undefined) return 0;
  const perFrame = FRAME_SAMPLES_BY_CONFIG[toc >> 3]!;
  const code = toc & 0x03;
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  return perFrame * frames;
}

export function opusHead(channels = 2, sampleRate = 48_000, preSkip = 0): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii');
  head.writeUInt8(1, 8); // version
  head.writeUInt8(channels, 9);
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(sampleRate, 12);
  head.writeInt16LE(0, 16); // gain
  head.writeUInt8(0, 18); // mapping family 0 (mono/stéréo)
  return head;
}

export function opusTags(vendor = 'meeting-recorder'): Buffer {
  const v = Buffer.from(vendor, 'utf8');
  const tags = Buffer.alloc(8 + 4 + v.length + 4);
  tags.write('OpusTags', 0, 'ascii');
  tags.writeUInt32LE(v.length, 8);
  v.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + v.length); // aucun commentaire
  return tags;
}

/** Table de laçage d'un paquet : des 255 puis le reste (0 si la taille est un multiple de 255). */
export function lacing(length: number): number[] {
  const values = new Array<number>(Math.floor(length / 255)).fill(255);
  values.push(length % 255);
  return values;
}

export const PAGE_BOS = 0x02;
export const PAGE_EOS = 0x04;

/** Construit une page OGG complète (CRC compris) à partir de paquets entiers. */
export function oggPage(packets: readonly Uint8Array[], options: { serial: number; sequence: number; granule: bigint; flags: number }): Buffer {
  const segments = packets.flatMap((p) => lacing(p.length));
  if (segments.length > 255) throw new Error(`Page OGG trop grande (${segments.length} segments)`);
  const bodyLength = packets.reduce((n, p) => n + p.length, 0);
  const page = Buffer.alloc(27 + segments.length + bodyLength);
  page.write('OggS', 0, 'ascii');
  page.writeUInt8(0, 4); // version
  page.writeUInt8(options.flags, 5);
  page.writeBigInt64LE(options.granule, 6);
  page.writeUInt32LE(options.serial, 14);
  page.writeUInt32LE(options.sequence, 18);
  page.writeUInt32LE(0, 22); // CRC, calculé plus bas
  page.writeUInt8(segments.length, 26);
  Buffer.from(segments).copy(page, 27);
  let offset = 27 + segments.length;
  for (const p of packets) {
    page.set(p, offset);
    offset += p.length;
  }
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

/** Nombre de trames de silence à insérer pour un écart `gapMs` entre deux paquets de 20 ms. */
export function silenceFramesForGap(gapMs: number, toleranceMs = 60): number {
  if (gapMs <= toleranceMs) return 0;
  return Math.max(0, Math.round(gapMs / 20) - 1);
}
