import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import type { GuildStorageRow } from '../db/schema.js';
import { rootFolderName, type StorageProvider } from '../domain/storage.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { decryptSecret, encryptSecret } from '../lib/secrets.js';
import { Dropbox } from '../storage/dropbox.js';
import { GoogleDrive } from '../storage/google.js';
import { OAuthApps, OAuthDenied, type DevicePoll, type DeviceStart } from '../storage/oauth.js';
import { OneDrive } from '../storage/onedrive.js';
import type { AccessToken, FileSource, StorageClient, Tokens } from '../storage/types.js';

/** Plafond d'attente d'une connexion par code (le panneau éphémère n'est plus modifiable après 15 min). */
const DEVICE_MAX_MS = 14 * 60_000;
/** Durée de validité d'un lien d'autorisation Dropbox. */
const DROPBOX_LINK_MS = 15 * 60_000;

export type ConnectResult = { ok: true; row: GuildStorageRow } | { ok: false; reason: 'expired' | 'denied' | 'error'; detail?: string };

export interface UploadFile {
  name: string;
  source: FileSource;
  mime: string;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

export function storageClient(provider: StorageProvider, token: AccessToken): StorageClient {
  if (provider === 'google') return new GoogleDrive(token);
  if (provider === 'onedrive') return new OneDrive(token);
  return new Dropbox(token);
}

/**
 * Stockage de chaque serveur (Google Drive, OneDrive ou Dropbox) : connexion depuis /config,
 * jetons chiffrés et renouvelés, et copie des fichiers d'une réunion.
 */
export class StorageService {
  readonly apps: OAuthApps;
  /** Connexions par code en attente de validation, par serveur. */
  private readonly pendingDevice = new Map<string, AbortController>();
  /** Liens Dropbox en attente du code, par serveur et administrateur. */
  private readonly dropboxPending = new Map<string, { verifier: string; expiresAt: number }>();

  constructor(
    private readonly repos: Repositories,
    config: AppConfig,
    private readonly log: Logger,
    /** Fabrique des clients (remplaçable dans les tests). */
    private readonly makeClient: typeof storageClient = storageClient,
  ) {
    this.apps = new OAuthApps(config.storage);
  }

  available(): StorageProvider[] {
    return this.apps.available();
  }

  get(guildId: string): Promise<GuildStorageRow | undefined> {
    return this.repos.getStorage(guildId);
  }

  /** Client du stockage connecté (null si aucun) ; les jetons renouvelés sont réenregistrés. */
  async client(guildId: string): Promise<{ row: GuildStorageRow; client: StorageClient } | null> {
    const row = await this.repos.getStorage(guildId);
    if (!row) return null;
    const plain = decryptSecret(row.credentials);
    if (!plain) throw new Error('Jetons du stockage illisibles (APP_SECRET_KEY changée ?) : reconnectez-le dans /config → Stockage');
    let tokens = JSON.parse(plain) as Tokens;
    const token: AccessToken = async () => {
      if (tokens.expiresAt - 60_000 > Date.now()) return tokens.accessToken;
      tokens = await this.apps.refresh(row.provider, tokens.refreshToken);
      await this.repos.updateStorage(guildId, { credentials: encryptSecret(JSON.stringify(tokens)) });
      return tokens.accessToken;
    };
    return { row, client: this.makeClient(row.provider, token) };
  }

  /**
   * Google ou OneDrive : code à saisir sur la page du service. Le bot attend la validation en
   * arrière-plan, puis appelle `onDone` (connecté, code expiré ou refusé).
   */
  async startDevice(guildId: string, userId: string, provider: 'google' | 'onedrive', onDone: (result: ConnectResult) => void): Promise<DeviceStart> {
    this.cancel(guildId);
    const start = await this.apps.startDevice(provider);
    const abort = new AbortController();
    this.pendingDevice.set(guildId, abort);
    const deadline = Date.now() + Math.min(start.expiresIn * 1000, DEVICE_MAX_MS);
    const finish = (result: ConnectResult) => {
      if (this.pendingDevice.get(guildId) === abort) this.pendingDevice.delete(guildId);
      if (!abort.signal.aborted) onDone(result);
    };
    void (async () => {
      let interval = start.interval;
      while (!abort.signal.aborted && Date.now() < deadline) {
        await sleep(interval * 1000, abort.signal);
        if (abort.signal.aborted) return;
        // Coupure réseau passagère : on réessaie au tour suivant ; un refus (OAuthDenied) arrête tout.
        const poll = await this.apps.pollDevice(provider, start.deviceCode).catch((err: unknown) => {
          if (err instanceof OAuthDenied) throw err;
          this.log.debug({ guildId, provider, err: errorMessage(err) }, 'Vérification de la connexion du stockage en échec');
          return { pending: true } as DevicePoll;
        });
        if ('tokens' in poll) return finish({ ok: true, row: await this.connect(guildId, userId, provider, poll.tokens) });
        if (poll.slowDown) interval += 5;
      }
      finish({ ok: false, reason: 'expired' });
    })().catch((err) => {
      this.log.warn({ guildId, provider, err: errorMessage(err) }, 'Connexion du stockage impossible');
      finish({ ok: false, reason: err instanceof OAuthDenied ? 'denied' : 'error', detail: errorMessage(err) });
    });
    return start;
  }

  /** Abandon d'une connexion par code en cours (nouvelle tentative, retour, autre service). */
  cancel(guildId: string): void {
    this.pendingDevice.get(guildId)?.abort();
    this.pendingDevice.delete(guildId);
  }

  /** Dropbox, étape 1 : lien d'autorisation. */
  dropboxLink(guildId: string, userId: string): string {
    const { url, verifier } = this.apps.dropboxAuthorize();
    this.dropboxPending.set(`${guildId}:${userId}`, { verifier, expiresAt: Date.now() + DROPBOX_LINK_MS });
    return url;
  }

  /** Dropbox, étape 2 : le code affiché par Dropbox. null si le lien a expiré (ou après un redémarrage). */
  async dropboxFinish(guildId: string, userId: string, code: string): Promise<GuildStorageRow | null> {
    const key = `${guildId}:${userId}`;
    const pending = this.dropboxPending.get(key);
    if (!pending || pending.expiresAt < Date.now()) return null;
    const tokens = await this.apps.dropboxExchange(code, pending.verifier);
    this.dropboxPending.delete(key);
    return this.connect(guildId, userId, 'dropbox', tokens);
  }

  /** Jetons obtenus : compte identifié, dossier racine créé (preuve que l'écriture marche), enregistrement. */
  private async connect(guildId: string, userId: string, provider: StorageProvider, tokens: Tokens): Promise<GuildStorageRow> {
    const client = this.makeClient(provider, async () => tokens.accessToken);
    const account = await client.account().catch(() => provider);
    const folder = (await this.repos.getStorage(guildId))?.folder ?? rootFolderName('');
    const root = await client.root(folder, null);
    const row = await this.repos.setStorage({ guildId, provider, credentials: encryptSecret(JSON.stringify(tokens)), account, connectedBy: userId });
    await this.repos.updateStorage(guildId, { rootId: root.id, rootUrl: root.url ?? null });
    this.log.info({ guildId, provider }, 'Stockage connecté');
    return { ...row, rootId: root.id, rootUrl: root.url ?? null };
  }

  /** Dossier racine (suivi même déplacé) ; son identifiant et son lien sont tenus à jour. */
  private async root(target: { row: GuildStorageRow; client: StorageClient }, signal?: AbortSignal): Promise<string> {
    const root = await target.client.root(target.row.folder, target.row.rootId, signal);
    if (root.id !== target.row.rootId || (root.url ?? null) !== target.row.rootUrl) {
      await this.repos.updateStorage(target.row.guildId, { rootId: root.id, rootUrl: root.url ?? null });
    }
    return root.id;
  }

  /** Vérification depuis /config : jetons valides et dossier racine accessible en écriture. */
  async test(guildId: string): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
    try {
      const target = await this.client(guildId);
      if (!target) return { ok: false, error: 'aucun stockage connecté' };
      const account = await target.client.account();
      await this.root(target);
      await this.repos.updateStorage(guildId, { lastOkAt: new Date(), lastError: null });
      return { ok: true, account };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  /** Nouveau nom : un nouveau dossier racine, créé à la prochaine copie (l'ancien est laissé tel quel). */
  async setFolder(guildId: string, name: string): Promise<string> {
    const folder = rootFolderName(name);
    await this.repos.updateStorage(guildId, { folder, rootId: null, rootUrl: null });
    return folder;
  }

  async disconnect(guildId: string): Promise<void> {
    this.cancel(guildId);
    await this.repos.removeStorage(guildId);
  }

  /**
   * Copie des fichiers d'une réunion dans « <dossier racine>/<dossier de la réunion> » ; les
   * fichiers du même nom sont remplacés (compte rendu corrigé, audio d'une nouvelle session).
   * null si le serveur n'a pas de stockage.
   */
  async upload(guildId: string, meetingFolder: string, files: readonly UploadFile[], signal?: AbortSignal): Promise<{ provider: StorageProvider; path: string } | null> {
    const target = await this.client(guildId);
    if (!target) return null;
    const path = [target.row.folder, meetingFolder];
    try {
      const folder = await target.client.folder(await this.root(target, signal), meetingFolder, signal);
      for (const file of files) await target.client.put(folder, file.name, file.source, file.mime, signal);
      await this.repos.updateStorage(guildId, { lastOkAt: new Date(), lastError: null });
    } catch (err) {
      if (!signal?.aborted) await this.repos.updateStorage(guildId, { lastError: errorMessage(err).slice(0, 300) }).catch(() => undefined);
      throw err;
    }
    return { provider: target.row.provider, path: path.join('/') };
  }
}
