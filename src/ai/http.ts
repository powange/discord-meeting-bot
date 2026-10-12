/** fetch avec délai : annule la requête après `timeoutMs` ou sur `signal`. */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  // Aucune redirection suivie : une URL autorisée ne doit pas pouvoir renvoyer ailleurs.
  const res = await fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.any(signals) });
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
