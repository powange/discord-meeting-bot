/** fetch avec délai : annule la requête après `timeoutMs` ou sur `signal`. */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  return fetch(url, { ...init, signal: AbortSignal.any(signals) });
}

export function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
