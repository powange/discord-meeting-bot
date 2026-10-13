import { request, requestJson, StorageHttpError } from './http.js';
import { chunks, sizeOf, type AccessToken, type FileSource, type StorageClient, type StorageFolder } from './types.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
/** Le dossier peut avoir été déplacé dans un Drive partagé : toutes les requêtes les incluent. */
const ALL_DRIVES = 'supportsAllDrives=true';

/** Littéral de requête Drive (apostrophes et antislashs échappés). */
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;

/**
 * Google Drive, accès « fichiers créés par l'application » (drive.file) : le bot ne voit que ses
 * propres dossiers et fichiers. Le dossier racine est suivi par son identifiant : on peut le
 * déplacer dans un dossier partagé ou un Drive partagé, le bot continue d'y écrire.
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
    const params = new URLSearchParams({ q: query, fields: 'files(id)', pageSize: '1', corpora: 'allDrives', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true' });
    const r = await requestJson<{ files: Array<{ id: string }> }>(`${API}/files?${params}`, { headers: await this.auth(), ...(signal ? { signal } : {}) });
    return r.files[0]?.id ?? null;
  }

  private async create(name: string, parent: string, signal?: AbortSignal): Promise<string> {
    const created = await requestJson<{ id: string }>(`${API}/files?fields=id&${ALL_DRIVES}`, {
      method: 'POST',
      headers: { ...(await this.auth()), 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
      ...(signal ? { signal } : {}),
    });
    return created.id;
  }

  async root(name: string, knownId: string | null, signal?: AbortSignal): Promise<StorageFolder> {
    if (knownId) {
      try {
        const r = await requestJson<{ id: string; trashed?: boolean }>(`${API}/files/${encodeURIComponent(knownId)}?fields=id,trashed&${ALL_DRIVES}`, {
          headers: await this.auth(),
          ...(signal ? { signal } : {}),
        });
        if (!r.trashed) return { id: r.id, url: folderUrl(r.id) };
      } catch (err) {
        // Supprimé définitivement, ou plus accessible : on en reprend un à la racine du Drive.
        if (!(err instanceof StorageHttpError && (err.status === 404 || err.status === 403))) throw err;
      }
    }
    const id = (await this.find(name, 'root', true, signal)) ?? (await this.create(name, 'root', signal));
    return { id, url: folderUrl(id) };
  }

  async folder(parent: string, name: string, signal?: AbortSignal): Promise<string> {
    return (await this.find(name, parent, true, signal)) ?? (await this.create(name, parent, signal));
  }

  async put(folder: string, name: string, source: FileSource, mime: string, signal?: AbortSignal): Promise<void> {
    const existing = await this.find(name, folder, false, signal);
    const total = await sizeOf(source);
    // Envoi « reprenable » : une session, puis le fichier par morceaux (remplacement s'il existe déjà).
    const session = await request(
      existing ? `${UPLOAD}/files/${existing}?uploadType=resumable&${ALL_DRIVES}` : `${UPLOAD}/files?uploadType=resumable&${ALL_DRIVES}`,
      {
        method: existing ? 'PATCH' : 'POST',
        headers: { ...(await this.auth()), 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime, 'x-upload-content-length': String(total) },
        body: JSON.stringify(existing ? { name } : { name, parents: [folder] }),
        ...(signal ? { signal } : {}),
      },
    );
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
