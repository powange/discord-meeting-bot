import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Chiffrement des clés d'API stockées en base (AES-256-GCM), avec une clé tirée de
 * APP_SECRET_KEY. Sans cette variable, les clés restent en clair (compatibilité) et un
 * avertissement est journalisé au démarrage. Format : « enc:v1:<iv>:<tag>:<données> » en base64.
 */
const PREFIX = 'enc:v1:';
let key: Buffer | null = null;

export function configureSecrets(secret: string | undefined): void {
  key = secret ? createHash('sha256').update(secret).digest() : null;
}

export function secretsEnabled(): boolean {
  return key !== null;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Valeur à stocker : chiffrée si une clé est configurée, sinon telle quelle. */
export function encryptSecret(plain: string): string {
  if (!key || isEncrypted(plain)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

/** Valeur utilisable : déchiffrée si besoin ; null si elle ne peut pas l'être (clé absente ou changée). */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!isEncrypted(stored)) return stored;
  if (!key) return null;
  try {
    const [iv, tag, data] = stored.slice(PREFIX.length).split(':') as [string, string, string];
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
