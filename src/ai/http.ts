import { lookup, type LookupAddress } from 'node:dns';
import { Agent } from 'undici';
import { hostMatches, HostNotAllowedError } from '../lib/hosts.js';

/** fetch avec délai : annule la requête après `timeoutMs` ou sur `signal`. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
  /** Hôtes autorisés (ai.allowedHosts) : vérifiés à la connexion elle-même. */
  allowedHosts: readonly string[] = [],
): Promise<Response> {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  const dispatcher = guardedDispatcher(allowedHosts);
  // Aucune redirection suivie : une URL autorisée ne doit pas pouvoir renvoyer ailleurs.
  const res = await fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.any(signals), ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new RedirectError(`Redirection refusée (${res.status}) depuis ${url}`);
  }
  return res;
}

export class RedirectError extends Error {
  override name = 'RedirectError';
}

export function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

const dispatchers = new Map<string, Agent>();

/**
 * Connexions limitées aux adresses autorisées, vérifiées au moment de se connecter : une
 * vérification préalable (assertUrlAllowed) puis une seconde résolution DNS par fetch laisseraient
 * un nom changer d'adresse entre les deux (DNS rebinding). Un nom autorisé explicitement garde
 * toutes ses adresses ; sinon, seules celles qui correspondent à un motif d'IP sont utilisées.
 */
export function guardedDispatcher(patterns: readonly string[]): Agent | undefined {
  if (patterns.length === 0) return undefined;
  const key = patterns.join(',');
  let agent = dispatchers.get(key);
  if (!agent) {
    agent = new Agent({ connect: { lookup: guardedLookup(patterns) } });
    dispatchers.set(key, agent);
  }
  return agent;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

export function guardedLookup(patterns: readonly string[]) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, '');
      const allowed = hostMatches(hostname, patterns) ? addresses : addresses.filter((a) => hostMatches(a.address, patterns));
      if (allowed.length === 0) {
        return callback(Object.assign(new HostNotAllowedError(`Hôte non autorisé : ${hostname} (adresse hors de ai.allowedHosts).`), { code: 'EHOSTNOTALLOWED' }), '');
      }
      if (options.all) return callback(null, allowed);
      callback(null, allowed[0]!.address, allowed[0]!.family);
    });
  };
}
