import { asciiJson } from '../domain/storage.js';
import { request, requestJson } from './http.js';
import { chunks, sizeOf, type AccessToken, type FileSource, type StorageClient, type StorageFolder } from './types.js';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
/**
 * Envoi en une requête jusqu'à 8 Mo ; au-delà, par morceaux (session d'envoi) : un audio de
 * 100 Mo n'est jamais chargé en entier en mémoire, dans le processus qui reçoit l'audio en direct.
 */
const SIMPLE_MAX = 8 * 1024 * 1024;

/**
 * Dropbox, accès « dossier de l'application » (Applications/<nom de l'app>) : les dossiers se
 * créent d'eux-mêmes à l'envoi d'un fichier.
 */
export class Dropbox implements StorageClient {
  constructor(private readonly token: AccessToken) {}

  private async auth(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.token()}` };
  }

  async account(): Promise<string> {
    const r = await requestJson<{ email?: string; name?: { display_name?: string } }>(`${API}/users/get_current_account`, { method: 'POST', headers: await this.auth() });
    return r.email ?? r.name?.display_name ?? 'Dropbox';
  }

  /** Le dossier de l'application ne se déplace pas : le dossier racine est retrouvé par son nom. */
  async root(name: string): Promise<StorageFolder> {
    return { id: `/${name}` };
  }

  async folder(parent: string, name: string): Promise<string> {
    return `${parent}/${name}`;
  }

  async put(folder: string, name: string, source: FileSource, _mime: string, signal?: AbortSignal): Promise<void> {
    const commit = { path: `${folder}/${name}`, mode: 'overwrite', autorename: false, mute: true };
    const upload = async (endpoint: string, arg: unknown, data: Buffer) =>
      request(`${CONTENT}/files/${endpoint}`, {
        method: 'POST',
        headers: { ...(await this.auth()), 'content-type': 'application/octet-stream', 'dropbox-api-arg': asciiJson(arg) },
        body: data,
        timeoutMs: 300_000,
        ...(signal ? { signal } : {}),
      });

    const total = await sizeOf(source);
    if (total <= SIMPLE_MAX) {
      const parts: Buffer[] = [];
      for await (const chunk of chunks(source)) parts.push(chunk.data);
      await upload('upload', commit, Buffer.concat(parts));
      return;
    }
    let sessionId = '';
    let offset = 0;
    for await (const chunk of chunks(source)) {
      if (!sessionId) {
        const res = await upload('upload_session/start', { close: false }, chunk.data);
        sessionId = ((await res.json()) as { session_id: string }).session_id;
      } else {
        await upload('upload_session/append_v2', { cursor: { session_id: sessionId, offset }, close: false }, chunk.data);
      }
      offset += chunk.data.length;
    }
    await upload('upload_session/finish', { cursor: { session_id: sessionId, offset }, commit }, Buffer.alloc(0));
  }
}
