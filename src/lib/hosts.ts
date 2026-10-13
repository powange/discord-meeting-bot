import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Hôtes autorisés pour les serveurs IA (transcription, LLM) : protège contre l'utilisation du
 * bot pour sonder le réseau local (SSRF). Motifs acceptés :
 * - nom exact (`pc-main`) ou avec joker en tête (`*.tailnet.ts.net`) ;
 * - adresse IPv4 (`192.168.1.20`) ou plage CIDR IPv4 (`192.168.1.0/24`, `100.64.0.0/10`).
 * Une liste vide n'impose aucune restriction (seuls les propriétaires configurent les URL).
 */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function ipMatches(ip: string, pattern: string): boolean {
  const [base, bitsRaw] = pattern.split('/');
  const target = ipv4ToInt(ip);
  const start = ipv4ToInt(base ?? '');
  if (target === null || start === null) return ip === pattern; // IPv6 : égalité stricte
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (target & mask) === (start & mask);
}

function isIpPattern(pattern: string): boolean {
  return isIP(pattern.split('/')[0] ?? '') !== 0;
}

function nameMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

/** Hôte (nom ou IP) autorisé, sans résolution DNS. */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return patterns.some((p) => isIpPattern(p) && ipMatches(bare, p));
  return patterns.some((p) => !isIpPattern(p) && nameMatches(bare, p));
}

export class HostNotAllowedError extends Error {
  override name = 'HostNotAllowedError';
}

type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * Vérifie l'URL : autorisée si son nom correspond à un motif de nom, ou si toutes ses adresses
 * résolues correspondent à des motifs d'IP (un nom DNS ne peut pas pointer en douce ailleurs).
 */
export async function assertUrlAllowed(url: string, patterns: readonly string[], resolve: Resolver = defaultResolver): Promise<void> {
  if (patterns.length === 0) return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new HostNotAllowedError(`URL invalide : ${url}`);
  }
  if (hostMatches(host, patterns)) return;
  const bare = host.replace(/^\[|\]$/g, '');
  if (!isIP(bare)) {
    const addresses = await resolve(bare).catch(() => []);
    if (addresses.length > 0 && addresses.every((a) => hostMatches(a, patterns))) return;
  }
  throw new HostNotAllowedError(`Hôte non autorisé : ${host} (voir ai.allowedHosts dans la configuration).`);
}

/** Hôte d'une URL (minuscules), ou la chaîne entière si elle n'est pas une URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}

/**
 * Message d'erreur d'un serveur appelé, réduit à son champ « error » / « message » / « detail »
 * (120 caractères au plus) : ces erreurs remontent dans Discord, et une page HTML ou une réponse
 * brute d'un service interne n'a pas à y apparaître.
 */
export function errorSnippet(body: string): string {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const err = json.error;
    const candidate =
      (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : undefined) ??
      (typeof err === 'string' ? err : undefined) ??
      (typeof json.message === 'string' ? json.message : undefined) ??
      (typeof json.detail === 'string' ? json.detail : undefined);
    return candidate ? candidate.replace(/\s+/g, ' ').slice(0, 120) : '';
  } catch {
    return '';
  }
}
