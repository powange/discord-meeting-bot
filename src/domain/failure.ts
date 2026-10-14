/** Cause d'échec d'une étape, en termes compréhensibles par tous (le détail technique va à l'alerte admin). */
export type FailureCause = 'unreachable' | 'timeout' | 'auth' | 'model' | 'busy' | 'disk' | 'discord' | 'tooLong' | 'context' | 'unknown';

export function failureCause(error: string): FailureCause {
  const e = error.toLowerCase();
  if (/durée maximale/.test(e)) return 'tooLong';
  if (isContextOverflow(e)) return 'context';
  if (/enospc|no space left|disque/.test(e)) return 'disk';
  if (/délai dépassé|timeout|timed out|etimedout|aborted|annul/.test(e)) return 'timeout';
  if (/econnrefused|enotfound|ehostunreach|econnreset|injoignable|indisponible|fetch failed|socket hang up|network/.test(e)) return 'unreachable';
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|api key|clé/.test(e)) return 'auth';
  if (/\b404\b|model.*(not found|introuvable|does not exist)|modèle/.test(e)) return 'model';
  if (/\b(429|503)\b|occupé|busy|overloaded/.test(e)) return 'busy';
  if (/discord|missing permissions|unknown (channel|message)|50013/.test(e)) return 'discord';
  return 'unknown';
}

/** Requête plus longue que le contexte chargé du modèle (LM Studio, Ollama, llama.cpp, OpenAI). */
export function isContextOverflow(error: string): boolean {
  return /exceeds? the (available )?context|context (length|window|size)|maximum context|n_ctx|too many tokens/i.test(error);
}

/** Échecs passagers (serveur éteint, occupé, trop lent) : le traitement se relance tout seul. */
export const TRANSIENT_CAUSES: readonly FailureCause[] = ['unreachable', 'timeout', 'busy'];
