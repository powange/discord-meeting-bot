/** Qualité de capture : détection des pertes d'audio (paquets reçus mais jamais écrits). */

export interface CaptureCounts {
  receivedPackets: number;
  writtenPackets: number;
  streamErrors: number;
}

/** En dessous (≈ 5 s de parole), trop peu de paquets pour juger. */
const MIN_PACKETS = 250;
/** Au-delà de 5 % de paquets perdus, l'audio est signalé comme incomplet. */
const MAX_LOSS = 0.05;

/** Part des paquets reçus qui n'ont pas pu être écrits (0 à 1). */
export function lossRatio(c: CaptureCounts): number {
  if (c.receivedPackets <= 0) return 0;
  return Math.max(0, 1 - c.writtenPackets / c.receivedPackets);
}

/** Pourcentage de perte à signaler, ou null si la capture est satisfaisante. */
export function captureWarning(c: CaptureCounts): number | null {
  if (c.receivedPackets < MIN_PACKETS) return null;
  const loss = lossRatio(c);
  if (loss > MAX_LOSS || (c.streamErrors > 0 && loss > 0.01)) return Math.max(1, Math.round(loss * 100));
  return null;
}
