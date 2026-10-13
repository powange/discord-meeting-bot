/** Stockages qu'un serveur peut connecter dans /config. */
export const STORAGE_PROVIDERS = ['google', 'onedrive', 'dropbox'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

/**
 * Nom de fichier ou de dossier accepté partout (Drive, OneDrive, Dropbox, Windows) : sans
 * caractères interdits, ni espace ou point final, et de longueur raisonnable.
 */
export function safeName(name: string, max = 100): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|#%]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[ .]+$/, '');
  return cleaned || 'sans titre';
}

/** Dossier d'une réunion : « 2026-10-13 18h00 - Bureau », triable par date. */
export function meetingFolderName(when: string, title: string): string {
  return safeName(`${when} - ${title}`);
}

/** Dossier racine choisi dans /config : un seul niveau, nom propre ; vide → nom par défaut. */
export function rootFolderName(input: string, fallback = 'Meeting recorder'): string {
  const name = input.trim();
  return name ? safeName(name, 80) : fallback;
}

/**
 * En-tête Dropbox-API-Arg : du JSON en ASCII seulement (Dropbox refuse les octets non ASCII
 * dans un en-tête HTTP), les autres caractères échappés en \uXXXX.
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Taille des morceaux d'envoi : multiple de 320 Kio (OneDrive) et de 256 Kio (Google), 10 Mio. */
export const CHUNK_BYTES = 32 * 320 * 1024;
