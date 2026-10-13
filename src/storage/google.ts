import { request, requestJson } from './http.js';
import { chunks, sizeOf, type AccessToken, type FileSource, type StorageClient } from './types.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';

/** Littéral de requête Drive (apostrophes et antislashs échappés). */
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Google Drive, accès « fichiers créés par l'application » (drive.file) : le bot ne voit que ses
 * propres dossiers et fichiers, qu'il retrouve par leur nom.
 */
export class GoogleDrive implements StorageClient {
  constructor(private readonly token: AccessToken) {}

  private async auth(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.token()}` };
  }

  async account(): Promise<string> {
    const r = await requestJson<{ user?: { emailAddress?: string; displayName?: string } }>(`${API}/about?fields=user(emailAddress,displayName)`, { headers: await this.auth() });
    return r.user?.emailAddress ?? r.user?.displayName ?? 'Google Drive';
  }

  private async find(name: string, parent: string, folder: boolean, signal?: AbortSignal): Promise<string | null> {
    const query = `name = ${q(name)} and ${q(parent)} in parents and trashed = false and mimeType ${folder ? '=' : '!='} '${FOLDER}'`;
    const r = await requestJson<{ files: Array<{ id: string }> }>(`${API}/files?${new URLSearchParams({ q: query, fields: 'files(id)', pageSize: '1' })}`, {
      headers: await this.auth(),
      ...(signal ? { signal } : {}),
    });
    return r.files[0]?.id ?? null;
  }

  async folder(path: readonly string[], signal?: AbortSignal): Promise<string> {
    let parent = 'root';
    for (const name of path) {
      const existing = await this.find(name, parent, true, signal);
      if (existing) {
        parent = existing;
        continue;
      }
      const created = await requestJson<{ id: string }>(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { ...(await this.auth()), 'content-type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
        ...(signal ? { signal } : {}),
      });
      parent = created.id;
    }
    return parent;
  }

  async put(folder: string, name: string, source: FileSource, mime: string, signal?: AbortSignal): Promise<void> {
    const existing = await this.find(name, folder, false, signal);
    const total = await sizeOf(source);
    // Envoi « reprenable » : une session, puis le fichier par morceaux (remplacement s'il existe déjà).
    const session = await request(existing ? `${UPLOAD}/files/${existing}?uploadType=resumable` : `${UPLOAD}/files?uploadType=resumable`, {
      method: existing ? 'PATCH' : 'POST',
      headers: { ...(await this.auth()), 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime, 'x-upload-content-length': String(total) },
      body: JSON.stringify(existing ? { name } : { name, parents: [folder] }),
      ...(signal ? { signal } : {}),
    });
    const location = session.headers.get('location');
    if (!location) throw new Error('Google Drive : session d’envoi non ouverte');
    for await (const chunk of chunks(source)) {
      const end = chunk.start + chunk.data.length - 1;
      await request(location, {
        method: 'PUT',
        headers: { 'content-range': total === 0 ? 'bytes */0' : `bytes ${chunk.start}-${end}/${total}` },
        body: chunk.data,
        accept: [308],
        timeoutMs: 300_000,
        ...(signal ? { signal } : {}),
      });
    }
  }
}
