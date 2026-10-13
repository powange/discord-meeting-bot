import { request, requestJson, StorageHttpError } from './http.js';
import { chunks, type AccessToken, type FileSource, type StorageClient } from './types.js';

const API = 'https://graph.microsoft.com/v1.0/me/drive';

/** Chemin OneDrive encodé segment par segment (« root:/A/B: »). */
const itemPath = (path: readonly string[]) => `root:/${path.map(encodeURIComponent).join('/')}:`;

/** OneDrive (personnel ou professionnel) : dossiers et fichiers adressés par leur chemin. */
export class OneDrive implements StorageClient {
  constructor(private readonly token: AccessToken) {}

  private async auth(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.token()}` };
  }

  async account(): Promise<string> {
    const r = await requestJson<{ owner?: { user?: { displayName?: string; email?: string } } }>(API, { headers: await this.auth() });
    return r.owner?.user?.email ?? r.owner?.user?.displayName ?? 'OneDrive';
  }

  /** L'identifiant d'un dossier est son chemin (« A/B ») : créé niveau par niveau s'il manque. */
  async folder(path: readonly string[], signal?: AbortSignal): Promise<string> {
    for (let i = 0; i < path.length; i++) {
      const parent = i === 0 ? `${API}/root/children` : `${API}/${itemPath(path.slice(0, i))}/children`;
      try {
        await request(parent, {
          method: 'POST',
          headers: { ...(await this.auth()), 'content-type': 'application/json' },
          body: JSON.stringify({ name: path[i], folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (!(err instanceof StorageHttpError && err.status === 409)) throw err; // existe déjà
      }
    }
    return path.join('/');
  }

  async put(folder: string, name: string, source: FileSource, _mime: string, signal?: AbortSignal): Promise<void> {
    const path = [...folder.split('/').filter(Boolean), name];
    const session = await requestJson<{ uploadUrl: string }>(`${API}/${itemPath(path)}/createUploadSession`, {
      method: 'POST',
      headers: { ...(await this.auth()), 'content-type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
      ...(signal ? { signal } : {}),
    });
    // L'adresse de session porte l'autorisation : pas d'en-tête Authorization.
    for await (const chunk of chunks(source)) {
      const end = chunk.start + Math.max(chunk.data.length, 1) - 1;
      await request(session.uploadUrl, {
        method: 'PUT',
        headers: { 'content-range': `bytes ${chunk.start}-${end}/${Math.max(chunk.total, 1)}` },
        body: chunk.data.length ? chunk.data : Buffer.from(' '),
        timeoutMs: 300_000,
        ...(signal ? { signal } : {}),
      });
    }
  }
}
