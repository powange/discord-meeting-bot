import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { asciiJson, CHUNK_BYTES, meetingFolderName, rootFolderName, safeName } from '../src/domain/storage.js';
import { configureSecrets, decryptSecret, encryptSecret } from '../src/lib/secrets.js';
import { StorageService } from '../src/services/storage.js';
import { Dropbox } from '../src/storage/dropbox.js';
import { GoogleDrive } from '../src/storage/google.js';
import { OAuthApps, OAuthDenied } from '../src/storage/oauth.js';
import { OneDrive } from '../src/storage/onedrive.js';
import { chunks } from '../src/storage/types.js';

/** Appel HTTP reçu par le faux réseau. */
interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  size: number;
}

/** Faux réseau : chaque réponse est choisie par `route` ; tous les appels sont gardés. */
function fakeFetch(route: (call: Call) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const raw = init.body;
      const body = raw instanceof URLSearchParams ? raw.toString() : Buffer.isBuffer(raw) ? raw.toString('latin1') : typeof raw === 'string' ? raw : '';
      const call = { method: init.method ?? 'GET', url, headers: (init.headers ?? {}) as Record<string, string>, body, size: Buffer.isBuffer(raw) ? raw.length : body.length };
      calls.push(call);
      const r = route(call);
      return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status ?? 200, headers: r.headers ?? {} });
    }),
  );
  return calls;
}

const token = async () => 'tok';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'storage-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  configureSecrets(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe('noms de fichiers et de dossiers', () => {
  it('caractères interdits remplacés, longueur bornée, jamais vide', () => {
    expect(meetingFolderName('2026-10-13 18h00', 'Bureau : budget / 2027 ?')).toBe('2026-10-13 18h00 - Bureau - budget - 2027 -');
    expect(safeName('  ..  ')).toBe('sans titre');
    expect(safeName('a'.repeat(300))).toHaveLength(100);
    expect(rootFolderName('  ')).toBe('Meeting recorder');
    expect(rootFolderName('Asso/Comptes rendus')).toBe('Asso-Comptes rendus');
  });

  it('en-tête Dropbox en ASCII : accents échappés, JSON toujours valide', () => {
    const header = asciiJson({ path: '/Réunion – été' });
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(header)).toEqual({ path: '/Réunion – été' });
  });

  it('fichier lu par morceaux, sans tout charger', async () => {
    const file = join(dir, 'a.bin');
    await writeFile(file, Buffer.alloc(25, 1));
    const parts = [];
    for await (const c of chunks({ path: file }, 10)) parts.push([c.start, c.data.length, c.total]);
    expect(parts).toEqual([
      [0, 10, 25],
      [10, 10, 25],
      [20, 5, 25],
    ]);
    expect(CHUNK_BYTES % (320 * 1024)).toBe(0);
    expect(CHUNK_BYTES % (256 * 1024)).toBe(0);
  });
});

describe('Google Drive', () => {
  it('racine retrouvée par son nom, sous-dossier créé ; nouveau fichier envoyé par morceaux dans une session', async () => {
    const calls = fakeFetch((c) => {
      if (c.url.includes('/drive/v3/files?q=')) return { json: { files: new URL(c.url).searchParams.get('q')!.includes("name = 'Asso'") ? [{ id: 'asso' }] : [] } };
      if (c.url.includes('/drive/v3/files?fields=id')) return { json: { id: 'reunion' } };
      if (c.url.includes('uploadType=resumable')) return { headers: { location: 'https://upload.example/session' } };
      return { status: c.headers['content-range']?.endsWith('/5') ? 200 : 308 };
    });
    const drive = new GoogleDrive(token);
    expect(await drive.root('Asso', null)).toEqual({ id: 'asso', url: 'https://drive.google.com/drive/folders/asso' });
    const folder = await drive.folder('asso', 'Réunion d’été');
    expect(folder).toBe('reunion');
    await drive.put(folder, 'cr.md', { data: Buffer.from('hello') }, 'text/markdown');
    const created = calls.find((c) => c.url.includes('fields=id&supportsAllDrives=true'))!;
    expect(JSON.parse(created.body)).toEqual({ name: 'Réunion d’été', mimeType: 'application/vnd.google-apps.folder', parents: ['asso'] });
    // Drives partagés inclus partout (le dossier a pu y être déplacé).
    expect(calls.filter((c) => c.url.includes('googleapis.com')).every((c) => c.url.includes('supportsAllDrives=true'))).toBe(true);
    const session = calls.find((c) => c.url.includes('uploadType=resumable'))!;
    expect(session.method).toBe('POST');
    expect(JSON.parse(session.body)).toEqual({ name: 'cr.md', parents: ['reunion'] });
    expect(session.headers.authorization).toBe('Bearer tok');
    const put = calls.at(-1)!;
    expect([put.method, put.url, put.headers['content-range'], put.headers.authorization]).toEqual(['PUT', 'https://upload.example/session', 'bytes 0-4/5', undefined]);
  });

  it('racine déplacée dans un dossier partagé : suivie par son identifiant ; à la corbeille ou supprimée : recréée', async () => {
    let state: 'ok' | 'trashed' | 'gone' = 'ok';
    const calls = fakeFetch((c) => {
      if (c.url.includes('/files/known?')) return state === 'gone' ? { status: 404, json: { error: { code: 404, message: 'File not found' } } } : { json: { id: 'known', trashed: state === 'trashed' } };
      if (c.url.includes('/drive/v3/files?q=')) return { json: { files: [] } };
      return { json: { id: 'fresh' } };
    });
    const drive = new GoogleDrive(token);
    expect((await drive.root('Asso', 'known')).id).toBe('known');
    expect(calls).toHaveLength(1); // aucune recherche par nom
    state = 'trashed';
    expect((await drive.root('Asso', 'known')).id).toBe('fresh');
    state = 'gone';
    expect((await drive.root('Asso', 'known')).id).toBe('fresh');
    expect(JSON.parse(calls.at(-1)!.body)).toMatchObject({ name: 'Asso', parents: ['root'] });
  });

  it('fichier déjà copié : remplacé (même identifiant), pas dupliqué', async () => {
    const calls = fakeFetch((c) => {
      if (c.url.includes('/drive/v3/files?q=')) return { json: { files: [{ id: 'f1' }] } };
      if (c.url.includes('uploadType=resumable')) return { headers: { location: 'https://upload.example/s' } };
      return {};
    });
    await new GoogleDrive(token).put('reunion', 'cr.md', { data: Buffer.from('v2') }, 'text/markdown');
    const session = calls.find((c) => c.url.includes('uploadType=resumable'))!;
    expect([session.method, session.url]).toEqual(['PATCH', 'https://www.googleapis.com/upload/drive/v3/files/f1?uploadType=resumable&supportsAllDrives=true']);
  });
});

describe('OneDrive', () => {
  it('racine existante (409) retrouvée ; sous-dossier et envoi par identifiant, sans jeton sur l’adresse de session', async () => {
    const calls = fakeFetch((c) => {
      if (c.url.endsWith('/me/drive/root/children')) return { status: 409, json: { error: { code: 'nameAlreadyExists', message: 'exists' } } };
      if (c.url.endsWith('/me/drive/root:/Asso')) return { json: { id: 'A!1', webUrl: 'https://onedrive.live.com/asso', parentReference: { driveId: 'd1' } } };
      if (c.url.endsWith('/children')) return { status: 201, json: { id: 'A!2', parentReference: { driveId: 'd1' } } };
      if (c.url.endsWith('/createUploadSession')) return { json: { uploadUrl: 'https://up.example/1' } };
      return { status: 201, json: {} };
    });
    const od = new OneDrive(token);
    expect(await od.root('Asso', null)).toEqual({ id: 'd1/A!1', url: 'https://onedrive.live.com/asso' });
    const folder = await od.folder('d1/A!1', 'Réunion 1');
    expect(folder).toBe('d1/A!2');
    expect(calls[2]!.url).toBe('https://graph.microsoft.com/v1.0/drives/d1/items/A!1/children');
    await od.put(folder, 'cr.md', { data: Buffer.from('hello') }, 'text/markdown');
    const session = calls.find((c) => c.url.endsWith('/createUploadSession'))!;
    expect(session.url).toBe('https://graph.microsoft.com/v1.0/drives/d1/items/A!2:/cr.md:/createUploadSession');
    expect(JSON.parse(session.body)).toEqual({ item: { '@microsoft.graph.conflictBehavior': 'replace' } });
    const put = calls.at(-1)!;
    expect([put.url, put.headers['content-range'], put.headers.authorization]).toEqual(['https://up.example/1', 'bytes 0-4/5', undefined]);
  });

  it('racine déplacée (autre drive, dossier partagé) : suivie par son identifiant', async () => {
    const calls = fakeFetch(() => ({ json: { id: 'A!1', webUrl: 'https://x.sharepoint.com/asso', parentReference: { driveId: 'shared' } } }));
    expect(await new OneDrive(token).root('Asso', 'd1/A!1')).toEqual({ id: 'shared/A!1', url: 'https://x.sharepoint.com/asso' });
    expect(calls).toHaveLength(1);
  });
});

describe('Dropbox', () => {
  it('envoi simple, chemin sous le dossier de l’application, fichier remplacé', async () => {
    const calls = fakeFetch(() => ({ json: {} }));
    const db = new Dropbox(token);
    const folder = await db.folder((await db.root('Asso')).id, 'Réunion');
    await db.put(folder, 'cr.md', { data: Buffer.from('hello') }, 'text/markdown');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://content.dropboxapi.com/2/files/upload');
    expect(JSON.parse(calls[0]!.headers['dropbox-api-arg']!)).toEqual({ path: '/Asso/Réunion/cr.md', mode: 'overwrite', autorename: false, mute: true });
  });

  it('erreurs lisibles : résumé Dropbox, et nouvelles tentatives sur 429', async () => {
    vi.useFakeTimers();
    let n = 0;
    fakeFetch(() => (++n < 3 ? { status: 429, headers: { 'retry-after': '1' } } : { status: 409, json: { error_summary: 'path/insufficient_space/', error: {} } }));
    const done = new Dropbox(token).put('/A', 'x.md', { data: Buffer.from('x') }, 'text/markdown').catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await done).toBe('HTTP 409 path/insufficient_space/');
    expect(n).toBe(3);
  });
});

describe('connexion OAuth', () => {
  const apps = new OAuthApps({ google: { clientId: 'gid', clientSecret: 'gsecret' }, onedrive: { clientId: 'msid' }, dropbox: { appKey: 'dbkey' } });

  it('services proposés : seulement ceux que l’opérateur a configurés', () => {
    expect(apps.available()).toEqual(['google', 'onedrive', 'dropbox']);
    expect(new OAuthApps({ google: { clientId: 'x' }, onedrive: {}, dropbox: { appKey: 'k' } }).available()).toEqual(['dropbox']);
  });

  it('code d’appareil : en attente, ralentir, puis jetons ; refus définitif', async () => {
    let answer: { status: number; json: unknown } = { status: 400, json: { error: 'authorization_pending' } };
    const calls = fakeFetch(() => answer);
    expect(await apps.pollDevice('google', 'dc')).toEqual({ pending: true });
    answer = { status: 400, json: { error: 'slow_down' } };
    expect(await apps.pollDevice('onedrive', 'dc')).toEqual({ pending: true, slowDown: true });
    answer = { status: 200, json: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } };
    expect(await apps.pollDevice('google', 'dc')).toMatchObject({ tokens: { accessToken: 'a', refreshToken: 'r' } });
    expect(new URLSearchParams(calls[0]!.body).get('client_secret')).toBe('gsecret');
    expect(new URLSearchParams(calls[1]!.body).get('client_secret')).toBeNull(); // Microsoft : client public
    answer = { status: 400, json: { error: 'expired_token' } };
    await expect(apps.pollDevice('google', 'dc')).rejects.toBeInstanceOf(OAuthDenied);
  });

  it('Dropbox : lien PKCE sans secret, échange avec le vérificateur', async () => {
    const { url, verifier } = apps.dropboxAuthorize();
    const params = new URL(url).searchParams;
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('token_access_type')).toBe('offline');
    expect(params.get('code_challenge')).not.toBe(verifier);
    const calls = fakeFetch(() => ({ json: { access_token: 'a', refresh_token: 'r', expires_in: 14400 } }));
    await apps.dropboxExchange(' CODE ', verifier);
    const body = new URLSearchParams(calls[0]!.body);
    expect([body.get('code'), body.get('code_verifier'), body.get('client_id')]).toEqual(['CODE', verifier, 'dbkey']);
  });

  it('renouvellement : jeton de renouvellement gardé s’il n’est pas renvoyé ; accès révoqué → message clair', async () => {
    let answer: { status: number; json: unknown } = { status: 200, json: { access_token: 'new', expires_in: 3600 } };
    fakeFetch(() => answer);
    expect(await apps.refresh('google', 'r0')).toMatchObject({ accessToken: 'new', refreshToken: 'r0' });
    answer = { status: 400, json: { error: 'invalid_grant' } };
    await expect(apps.refresh('onedrive', 'r0')).rejects.toThrow(/révoqué.*\/config → Stockage/);
  });
});

describe('StorageService', () => {
  const config = buildConfig(
    { discord: { token: 'x' }, database: { url: 'postgres://a@b/c' }, storage: { google: { clientId: 'gid', clientSecret: 's' }, dropbox: { appKey: 'k' } } },
    {},
  );
  const log = pino({ level: 'silent' });

  function setup(initial?: { expiresAt: number }) {
    configureSecrets('secret');
    let row = initial
      ? {
          guildId: 'g',
          provider: 'google' as const,
          credentials: encryptSecret(JSON.stringify({ accessToken: 'old', refreshToken: 'r', expiresAt: initial.expiresAt })),
          account: 'a@b.c',
          folder: 'Asso',
          connectedBy: 'u',
          connectedAt: new Date(),
          rootId: null as string | null,
          rootUrl: null as string | null,
          lastOkAt: null as Date | null,
          lastError: null as string | null,
        }
      : undefined;
    const repos = {
      getStorage: async () => row,
      setStorage: vi.fn(async (v: object) => (row = { ...row!, ...v, folder: row?.folder ?? 'Meeting recorder', lastOkAt: null, lastError: null } as NonNullable<typeof row>)),
      updateStorage: vi.fn(async (_g: string, patch: object) => void (row = { ...row!, ...patch })),
      removeStorage: async () => void (row = undefined),
    };
    const client = {
      account: vi.fn(async () => 'moi@gmail.com'),
      root: vi.fn(async (name: string, known: string | null) => ({ id: known ?? `id-${name}`, url: `https://drive/${known ?? `id-${name}`}` })),
      folder: vi.fn(async (parent: string, name: string) => `${parent}/${name}`),
      put: vi.fn(async () => undefined),
    };
    const tokens: string[] = [];
    const service = new StorageService(repos as never, config, log, (_p, t) => ({
      ...client,
      put: vi.fn(async (...args: unknown[]) => {
        tokens.push(await t());
        return client.put(...(args as []));
      }),
    }));
    return { service, repos, client, tokens, row: () => row };
  }

  it('services proposés selon la configuration de l’opérateur', () => {
    expect(setup().service.available()).toEqual(['google', 'dropbox']);
  });

  it('jeton expiré : renouvelé avant l’envoi et réenregistré chiffré ; copie réussie notée', async () => {
    const { service, tokens, row } = setup({ expiresAt: Date.now() - 1000 });
    fakeFetch(() => ({ json: { access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 } }));
    const result = await service.upload('g', '2026-10-13 18h00 - Bureau', [{ name: 'cr.md', source: { data: Buffer.from('x') }, mime: 'text/markdown' }]);
    expect(result).toEqual({ provider: 'google', path: 'Asso/2026-10-13 18h00 - Bureau' });
    expect(tokens).toEqual(['fresh']);
    expect(row()!.credentials.startsWith('enc:v1:')).toBe(true);
    expect(JSON.parse(decryptSecret(row()!.credentials)!)).toMatchObject({ accessToken: 'fresh', refreshToken: 'r2' });
    expect(row()!.lastOkAt).toBeInstanceOf(Date);
  });

  it('dossier racine déplacé par l’utilisateur : les copies vont dans le dossier suivi ; nouveau nom → nouveau dossier', async () => {
    const { service, client, row } = setup({ expiresAt: Date.now() + 3_600_000 });
    await service.upload('g', 'R1', [{ name: 'a', source: { data: Buffer.from('x') }, mime: 'text/plain' }]);
    expect(row()!.rootId).toBe('id-Asso');
    client.root.mockResolvedValueOnce({ id: 'id-Asso', url: 'https://drive/partage/id-Asso' }); // déplacé : même id, autre lien
    await service.upload('g', 'R2', [{ name: 'a', source: { data: Buffer.from('x') }, mime: 'text/plain' }]);
    expect(client.root).toHaveBeenLastCalledWith('Asso', 'id-Asso', undefined);
    expect(client.folder).toHaveBeenLastCalledWith('id-Asso', 'R2', undefined);
    expect(row()!.rootUrl).toBe('https://drive/partage/id-Asso');
    await service.setFolder('g', 'Comptes rendus');
    expect([row()!.folder, row()!.rootId, row()!.rootUrl]).toEqual(['Comptes rendus', null, null]);
  });

  it('échec d’envoi : erreur gardée pour /config, puis levée (étape en échec, relançable)', async () => {
    const { service, client, row } = setup({ expiresAt: Date.now() + 3_600_000 });
    client.put.mockRejectedValueOnce(new Error('HTTP 403 storageQuotaExceeded'));
    await expect(service.upload('g', 'R', [{ name: 'a', source: { data: Buffer.from('x') }, mime: 'text/plain' }])).rejects.toThrow('storageQuotaExceeded');
    expect(row()!.lastError).toBe('HTTP 403 storageQuotaExceeded');
  });

  it('aucun stockage connecté : rien n’est envoyé', async () => {
    expect(await setup().service.upload('g', 'R', [])).toBeNull();
  });

  it('connexion par code : attend la validation, vérifie l’écriture, enregistre le compte', async () => {
    vi.useFakeTimers();
    const { service, client, repos } = setup();
    let validated = false;
    fakeFetch((c) => {
      if (c.url.endsWith('/device/code')) return { json: { device_code: 'dc', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', interval: 5, expires_in: 1800 } };
      return validated ? { json: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } } : { status: 428, json: { error: 'authorization_pending' } };
    });
    const onDone = vi.fn();
    const start = await service.startDevice('g', 'admin', 'google', onDone);
    expect([start.userCode, start.verificationUrl]).toEqual(['ABCD-EFGH', 'https://www.google.com/device']);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(onDone).not.toHaveBeenCalled();
    validated = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(client.root).toHaveBeenCalledWith('Meeting recorder', null);
    expect(repos.updateStorage).toHaveBeenCalledWith('g', { rootId: 'id-Meeting recorder', rootUrl: 'https://drive/id-Meeting recorder' });
    expect(repos.setStorage).toHaveBeenCalledWith(expect.objectContaining({ guildId: 'g', provider: 'google', account: 'moi@gmail.com', connectedBy: 'admin' }));
  });

  it('connexion par code : une coupure réseau pendant l’attente ne fait pas échouer la connexion', async () => {
    vi.useFakeTimers();
    const { service } = setup();
    let polls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/device/code')) return Response.json({ device_code: 'dc', user_code: 'X', verification_url: 'u', interval: 5, expires_in: 1800 });
        if (++polls === 1) throw new TypeError('fetch failed');
        return Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
      }),
    );
    const onDone = vi.fn();
    await service.startDevice('g', 'admin', 'google', onDone);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it('connexion par code annulée (Annuler, autre service) : plus d’attente ni de rappel', async () => {
    vi.useFakeTimers();
    const { service } = setup();
    const calls = fakeFetch((c) =>
      c.url.endsWith('/device/code')
        ? { json: { device_code: 'dc', user_code: 'X', verification_url: 'u', interval: 5, expires_in: 1800 } }
        : { status: 428, json: { error: 'authorization_pending' } },
    );
    const onDone = vi.fn();
    await service.startDevice('g', 'admin', 'google', onDone);
    service.cancel('g');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('Dropbox : code d’un lien inconnu ou expiré → null (recommencer)', async () => {
    const { service } = setup();
    expect(await service.dropboxFinish('g', 'admin', 'CODE')).toBeNull();
    service.dropboxLink('g', 'autre');
    expect(await service.dropboxFinish('g', 'admin', 'CODE')).toBeNull();
  });
});
