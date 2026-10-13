import { request, requestJson, StorageHttpError } from './http.js';
import { chunks, type AccessToken, type FileSource, type StorageClient, type StorageFolder } from './types.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

interface Item {
  id: string;
  webUrl?: string;
  parentReference?: { driveId?: string };
}

/**
 * Identifiant d'un dossier : « <drive>/<élément> ». Le drive est gardé car un dossier déplacé dans
 * un dossier partagé (ou une bibliothèque SharePoint) peut changer de drive.
 */
const ref = (item: Item, driveId?: string) => `${item.parentReference?.driveId ?? driveId}/${item.id}`;
const itemUrl = (id: string) => {
  const [drive, item] = id.split('/') as [string, string];
  return `${GRAPH}/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}`;
};

/** OneDrive (personnel ou professionnel) : dossiers suivis par leur identifiant, même déplacés. */
export class OneDrive implements StorageClient {
  constructor(private readonly token: AccessToken) {}

  private async auth(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.token()}` };
  }

  async account(): Promise<string> {
    const r = await requestJson<{ owner?: { user?: { displayName?: string; email?: string } } }>(`${GRAPH}/me/drive`, { headers: await this.auth() });
    return r.owner?.user?.email ?? r.owner?.user?.displayName ?? 'OneDrive';
  }

  /** Crée le dossier dans `children` ; s'il existe déjà (409), le renvoie via `byName`. */
  private async createOrGet(children: string, byName: string, name: string, signal?: AbortSignal): Promise<Item> {
    try {
      return await requestJson<Item>(children, {
        method: 'POST',
        headers: { ...(await this.auth()), 'content-type': 'application/json' },
        body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (!(err instanceof StorageHttpError && err.status === 409)) throw err;
      return requestJson<Item>(byName, { headers: await this.auth(), ...(signal ? { signal } : {}) });
    }
  }

  async root(name: string, knownId: string | null, signal?: AbortSignal): Promise<StorageFolder> {
    if (knownId?.includes('/')) {
      try {
        const item = await requestJson<Item>(`${itemUrl(knownId)}?select=id,webUrl,parentReference`, { headers: await this.auth(), ...(signal ? { signal } : {}) });
        return { id: ref(item, knownId.split('/')[0]), url: item.webUrl };
      } catch (err) {
        if (!(err instanceof StorageHttpError && (err.status === 404 || err.status === 403))) throw err;
      }
    }
    const item = await this.createOrGet(`${GRAPH}/me/drive/root/children`, `${GRAPH}/me/drive/root:/${encodeURIComponent(name)}`, name, signal);
    return { id: ref(item), url: item.webUrl };
  }

  async folder(parent: string, name: string, signal?: AbortSignal): Promise<string> {
    const base = itemUrl(parent);
    const item = await this.createOrGet(`${base}/children`, `${base}:/${encodeURIComponent(name)}`, name, signal);
    return ref(item, parent.split('/')[0]);
  }

  async put(folder: string, name: string, source: FileSource, _mime: string, signal?: AbortSignal): Promise<void> {
    const session = await requestJson<{ uploadUrl: string }>(`${itemUrl(folder)}:/${encodeURIComponent(name)}:/createUploadSession`, {
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
