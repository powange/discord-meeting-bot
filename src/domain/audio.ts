/** Choix du débit de l'audio complet pour tenir dans la limite de pièce jointe Discord. */

/** Limite d'envoi par niveau de boost du serveur (octets). */
export function uploadLimitBytes(premiumTier: number): number {
  if (premiumTier >= 3) return 100 * 1024 * 1024;
  if (premiumTier >= 2) return 50 * 1024 * 1024;
  return 10 * 1024 * 1024;
}

export const MAX_BITRATE_KBPS = 32;
/** En dessous, la voix devient pénible à écouter : on ne joint plus le fichier. */
export const MIN_BITRATE_KBPS = 12;

/**
 * Débit (kbit/s) pour que `durationMs` d'audio tienne dans `limitBytes`, avec 8 % de marge
 * (conteneur OGG). `null` si même le débit minimal ne suffit pas.
 */
export function bitrateForLimit(durationMs: number, limitBytes: number): number | null {
  const seconds = Math.max(1, durationMs / 1000);
  const fitting = Math.floor((limitBytes * 8 * 0.92) / seconds / 1000);
  if (fitting < MIN_BITRATE_KBPS) return null;
  return Math.min(MAX_BITRATE_KBPS, fitting);
}

export const MAX_PARTS = 10;
/** Débit visé quand on découpe : on préfère plus de parties à une voix trop compressée. */
export const PART_TARGET_KBPS = 24;

export interface PartsPlan {
  parts: number;
  kbps: number;
  /** Durée de chaque partie (la dernière peut être plus courte). */
  partMs: number;
}

/**
 * Plan de publication de l'audio complet : un seul fichier au meilleur débit s'il tient dans la
 * limite d'envoi, sinon le plus petit nombre de parties (≤ 10) qui garde au moins 24 kbps, ou à
 * défaut le débit minimal. `null` si même 10 parties au débit minimal ne tiennent pas.
 */
export function planParts(durationMs: number, limitBytes: number): PartsPlan | null {
  const single = bitrateForLimit(durationMs, limitBytes);
  if (single !== null) return { parts: 1, kbps: single, partMs: durationMs };
  let fallback: PartsPlan | null = null;
  for (let parts = 2; parts <= MAX_PARTS; parts++) {
    const partMs = Math.ceil(durationMs / parts);
    const kbps = bitrateForLimit(partMs, limitBytes);
    if (kbps === null) continue;
    if (kbps >= PART_TARGET_KBPS) return { parts, kbps, partMs };
    fallback ??= { parts, kbps, partMs };
  }
  return fallback;
}

/** « 1:05:30 » ou « 41:20 » : repère de temps lisible. */
export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
