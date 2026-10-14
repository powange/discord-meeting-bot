import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config/index.js';
import type { StorageProvider } from '../domain/storage.js';
import { request, requestJson, StorageHttpError } from './http.js';
import type { Tokens } from './types.js';

/**
 * Connexion des stockages sans page web côté bot (il n'expose aucun port) :
 * - Google et Microsoft : « appareil » — le bot affiche un code que l'administrateur saisit sur
 *   google.com/device ou microsoft.com/devicelogin, pendant que le bot attend la validation ;
 * - Dropbox (pas de connexion par appareil) : lien d'autorisation, puis le code affiché par
 *   Dropbox est collé dans /config (PKCE, sans secret).
 * Accès demandés au plus juste : fichiers créés par le bot (Google), dossier de l'application (Dropbox).
 */

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const MS_SCOPE = 'Files.ReadWrite offline_access';
const MS_BASE = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  /** Secondes entre deux vérifications. */
  interval: number;
  /** Validité du code (secondes). */
  expiresIn: number;
}

/** Résultat d'une vérification : connecté, pas encore validé, ou ralentir. */
export type DevicePoll = { tokens: Tokens } | { pending: true; slowDown?: boolean };

/** Refus définitif (code expiré, accès refusé) : inutile de continuer à attendre. */
export class OAuthDenied extends Error {
  override name = 'OAuthDenied';
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields);
const toTokens = (r: TokenResponse, previousRefresh?: string): Tokens => {
  const refreshToken = r.refresh_token ?? previousRefresh;
  if (!refreshToken) throw new Error('Le service n’a pas fourni de jeton de renouvellement');
  return { accessToken: r.access_token, refreshToken, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
};

export class OAuthApps {
  constructor(private readonly config: AppConfig['storage']) {}

  /** Stockages proposés dans /config : ceux dont l'opérateur a fourni l'application OAuth. */
  available(): StorageProvider[] {
    const c = this.config;
    return [
      ...(c.google.clientId && c.google.clientSecret ? (['google'] as const) : []),
      ...(c.onedrive.clientId ? (['onedrive'] as const) : []),
      ...(c.dropbox.appKey ? (['dropbox'] as const) : []),
    ];
  }

  async startDevice(provider: 'google' | 'onedrive'): Promise<DeviceStart> {
    if (provider === 'google') {
      const r = await requestJson<{ device_code: string; user_code: string; verification_url: string; interval?: number; expires_in: number }>(
        'https://oauth2.googleapis.com/device/code',
        { method: 'POST', body: form({ client_id: this.config.google.clientId!, scope: GOOGLE_SCOPE }) },
      );
      return { deviceCode: r.device_code, userCode: r.user_code, verificationUrl: r.verification_url, interval: r.interval ?? 5, expiresIn: r.expires_in };
    }
    const r = await requestJson<{ device_code: string; user_code: string; verification_uri: string; interval?: number; expires_in: number }>(`${MS_BASE}/devicecode`, {
      method: 'POST',
      body: form({ client_id: this.config.onedrive.clientId!, scope: MS_SCOPE }),
    });
    return { deviceCode: r.device_code, userCode: r.user_code, verificationUrl: r.verification_uri, interval: r.interval ?? 5, expiresIn: r.expires_in };
  }

  async pollDevice(provider: 'google' | 'onedrive', deviceCode: string): Promise<DevicePoll> {
    const [url, fields] =
      provider === 'google'
        ? ['https://oauth2.googleapis.com/token', { client_id: this.config.google.clientId!, client_secret: this.config.google.clientSecret!, device_code: deviceCode, grant_type: DEVICE_GRANT }]
        : [`${MS_BASE}/token`, { client_id: this.config.onedrive.clientId!, device_code: deviceCode, grant_type: DEVICE_GRANT }];
    try {
      return { tokens: toTokens(await requestJson<TokenResponse>(url, { method: 'POST', body: form(fields), attempts: 1 })) };
    } catch (err) {
      if (!(err instanceof StorageHttpError)) throw err;
      if (err.code === 'authorization_pending') return { pending: true };
      if (err.code === 'slow_down') return { pending: true, slowDown: true };
      throw new OAuthDenied(err.message);
    }
  }

  /** Dropbox : lien d'autorisation (le code s'affiche chez Dropbox) et vérificateur PKCE à garder. */
  dropboxAuthorize(): { url: string; verifier: string } {
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
      client_id: this.config.dropbox.appKey!,
      response_type: 'code',
      token_access_type: 'offline',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return { url: `https://www.dropbox.com/oauth2/authorize?${params}`, verifier };
  }

  async dropboxExchange(code: string, verifier: string): Promise<Tokens> {
    const r = await requestJson<TokenResponse>('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      body: form({ code: code.trim(), grant_type: 'authorization_code', client_id: this.config.dropbox.appKey!, code_verifier: verifier }),
      attempts: 1,
    });
    return toTokens(r);
  }

  /**
   * Accès retiré chez le fournisseur (déconnexion depuis /config) : le jeton de renouvellement ne
   * sert plus, même s'il traîne dans une sauvegarde. Google et Dropbox seulement ; Microsoft n'a
   * pas de révocation pour une application publique (accès retiré par l'utilisateur sur son
   * compte). Renvoie false si rien n'a été révoqué.
   */
  async revoke(provider: StorageProvider, tokens: Tokens): Promise<boolean> {
    if (provider === 'google') {
      await request('https://oauth2.googleapis.com/revoke', { method: 'POST', body: form({ token: tokens.refreshToken }), attempts: 1 });
      return true;
    }
    if (provider === 'dropbox') {
      const access = tokens.expiresAt - 60_000 > Date.now() ? tokens.accessToken : (await this.refresh(provider, tokens.refreshToken)).accessToken;
      await request('https://api.dropboxapi.com/2/auth/token/revoke', { method: 'POST', headers: { Authorization: `Bearer ${access}` }, attempts: 1 });
      return true;
    }
    return false;
  }

  /** Nouveau jeton d'accès (Microsoft renvoie aussi un nouveau jeton de renouvellement). */
  async refresh(provider: StorageProvider, refreshToken: string): Promise<Tokens> {
    const c = this.config;
    const [url, fields]: [string, Record<string, string>] =
      provider === 'google'
        ? ['https://oauth2.googleapis.com/token', { client_id: c.google.clientId ?? '', client_secret: c.google.clientSecret ?? '', refresh_token: refreshToken, grant_type: 'refresh_token' }]
        : provider === 'onedrive'
          ? [`${MS_BASE}/token`, { client_id: c.onedrive.clientId ?? '', refresh_token: refreshToken, grant_type: 'refresh_token', scope: MS_SCOPE }]
          : ['https://api.dropboxapi.com/oauth2/token', { client_id: c.dropbox.appKey ?? '', refresh_token: refreshToken, grant_type: 'refresh_token' }];
    try {
      return toTokens(await requestJson<TokenResponse>(url, { method: 'POST', body: form(fields) }), refreshToken);
    } catch (err) {
      // Accès retiré par l'utilisateur, mot de passe changé, application supprimée…
      if (err instanceof StorageHttpError && (err.code === 'invalid_grant' || err.status === 400 || err.status === 401)) {
        throw new OAuthDenied(`Accès au stockage révoqué : reconnectez-le dans /config → Stockage (${err.message})`);
      }
      throw err;
    }
  }
}
