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
