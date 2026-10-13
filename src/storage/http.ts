/** Erreur d'un service de stockage : statut HTTP et message lisible (jamais de jeton). */
export class StorageHttpError extends Error {
  override name = 'StorageHttpError';
  constructor(
    readonly status: number,
    message: string,
    /** Code d'erreur OAuth (authorization_pending, invalid_grant…), s'il y en a un. */
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | URLSearchParams | null;
  /** Délai par tentative (défaut : 60 s). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Statuts acceptés en plus de 2xx (ex. 308 pour un envoi Google en plusieurs morceaux). */
  accept?: readonly number[];
  /** Tentatives sur 429, 5xx et erreurs réseau (défaut : 3). */
  attempts?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

/** Partie lisible d'une réponse d'erreur (JSON OAuth, Google, Microsoft ou Dropbox). */
function describe(status: number, text: string): { message: string; code?: string } {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const err = body.error;
    // Dropbox : { error_summary: "path/conflict/…", error: { ".tag": … } }.
    if (typeof body.error_summary === 'string') return { message: `HTTP ${status} ${body.error_summary}`.slice(0, 300), code: body.error_summary };
    if (typeof err === 'string') {
      const detail = typeof body.error_description === 'string' ? `: ${body.error_description}` : typeof body.error_summary === 'string' ? `: ${body.error_summary}` : '';
      return { message: `HTTP ${status} ${err}${detail}`.slice(0, 300), code: err };
    }
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      const code = typeof e.code === 'string' ? e.code : typeof e.status === 'string' ? e.status : undefined;
      return { message: `HTTP ${status} ${typeof e.message === 'string' ? e.message : (code ?? '')}`.slice(0, 300), ...(code ? { code } : {}) };
    }
  } catch {
    // Pas du JSON.
  }
  return { message: `HTTP ${status} ${text.replace(/\s+/g, ' ').trim()}`.slice(0, 300) };
}

/**
 * Requête vers un service de stockage, avec délai et nouvelles tentatives (429 et 5xx, en
 * respectant Retry-After). Les autres erreurs sont levées aussitôt en StorageHttpError.
 */
export async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { method: opts.method ?? 'GET', headers: opts.headers ?? {}, body: opts.body ?? null, signal, redirect: 'manual' });
    } catch (err) {
      if (opts.signal?.aborted || attempt >= attempts) throw timeout.aborted ? new Error(`Stockage : délai dépassé (${new URL(url).host})`) : err;
      await sleep(1000 * 2 ** attempt, opts.signal);
      continue;
    }
    if (res.ok || opts.accept?.includes(res.status)) return res;
    const text = await res.text().catch(() => '');
    const retriable = res.status === 429 || res.status >= 500;
    if (retriable && attempt < attempts) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt, opts.signal);
      continue;
    }
    const { message, code } = describe(res.status, text);
    throw new StorageHttpError(res.status, message, code);
  }
}

export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(url, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}
