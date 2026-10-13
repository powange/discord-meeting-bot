import { open, stat } from 'node:fs/promises';
import { CHUNK_BYTES } from '../domain/storage.js';

/** Jetons OAuth d'un stockage connecté (gardés chiffrés en base). */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Expiration du jeton d'accès (ms depuis l'époque). */
  expiresAt: number;
}

/** Fournit un jeton d'accès valide (renouvelé au besoin). */
export type AccessToken = () => Promise<string>;

/** Fichier à envoyer : sur le disque (audio) ou en mémoire (Markdown). */
export type FileSource = { path: string } | { data: Buffer };

/** Opérations communes à Google Drive, OneDrive et Dropbox. */
export interface StorageClient {
  /** Compte connecté (adresse ou nom), affiché dans /config. */
  account(): Promise<string>;
  /** Dossier (créé au besoin) : chemin depuis la racine accessible au bot. Renvoie son identifiant. */
  folder(path: readonly string[], signal?: AbortSignal): Promise<string>;
  /** Envoie un fichier dans le dossier, en remplaçant celui du même nom. */
  put(folder: string, name: string, source: FileSource, mime: string, signal?: AbortSignal): Promise<void>;
}

export async function sizeOf(source: FileSource): Promise<number> {
  return 'data' in source ? source.data.length : (await stat(source.path)).size;
}

/** Morceaux successifs du fichier (lu au fil de l'envoi : un audio de 300 Mo ne tient pas en mémoire). */
export async function* chunks(source: FileSource, size = CHUNK_BYTES): AsyncGenerator<{ data: Buffer; start: number; total: number }> {
  if ('data' in source) {
    for (let start = 0; start < source.data.length || start === 0; start += size) {
      yield { data: source.data.subarray(start, start + size), start, total: source.data.length };
      if (source.data.length === 0) return;
    }
    return;
  }
  const handle = await open(source.path, 'r');
  try {
    const total = (await handle.stat()).size;
    if (total === 0) {
      yield { data: Buffer.alloc(0), start: 0, total };
      return;
    }
    for (let start = 0; start < total; start += size) {
      const buffer = Buffer.alloc(Math.min(size, total - start));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      yield { data: buffer.subarray(0, bytesRead), start, total };
    }
  } finally {
    await handle.close();
  }
}
