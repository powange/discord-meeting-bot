/** Taille du prompt de vocabulaire envoyé à Whisper (il n'en lit de toute façon que ~224 tokens). */
export const PROMPT_MAX = 800;
export const VOCABULARY_MAX_TERMS = 100;
const TERM_MAX = 60;

/** « Pol, Apothicaire ; Tabac\nLiteLLM » → termes uniques, dans l'ordre. */
export function parseVocabulary(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,;\n]+/)) {
    const term = raw.trim().replace(/\s+/g, ' ').slice(0, TERM_MAX);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out.slice(0, VOCABULARY_MAX_TERMS);
}

/** Mots capitalisés courants en début de phrase : ce ne sont pas des noms propres. */
const STOPWORDS = new Set(
  (
    "le la les l un une des du de d au aux il elle ils elles on nous vous je j tu ce c cet cette ces ça " +
    'mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs et ou mais donc or ni car si ne pas non oui ' +
    'dans pour par avec sans sur sous chez vers entre lors quand comme puis alors ensuite enfin aussi très plus moins ' +
    "contrairement attention remplacer remplace corriger corrige écrire écris écrit mettre mets dire dit c'est il y a " +
    'personne décision action point sujet réunion résumé transcription'
  ).split(' '),
);

/**
 * Termes à soumettre à Whisper tirés des consignes de correction (« Pol et non Paul ») : noms
 * propres et termes entre guillemets, sauf ceux qui suivent une négation — c'est l'erreur à éviter,
 * l'ajouter au vocabulaire la renforcerait.
 */
export function correctionTerms(corrections: readonly string[]): string[] {
  const terms: string[] = [];
  for (const correction of corrections) {
    // Retire « et non Paul », « pas Paul », « au lieu de Paul », « plutôt que Paul » (mot suivant compris).
    const kept = correction.replace(/\b(?:(?:et non|non pas|et pas|pas|au lieu de|plutôt que)\s+|(?:au lieu d|plutôt qu)['’]\s*)[«"“]?\s*[\p{L}\p{N}'’-]+(?:\s*[»"”])?/giu, ' ');
    for (const [, quoted] of kept.matchAll(/[«"“]\s*([^»"”]{2,60}?)\s*[»"”]/gu)) terms.push(quoted!);
    for (const [word] of kept.matchAll(/\p{Lu}[\p{L}\p{N}'’-]{2,}/gu)) {
      if (!STOPWORDS.has(word.toLowerCase().replace(/['’].*$/, ''))) terms.push(word);
    }
  }
  return parseVocabulary(terms.join('\n'));
}

/**
 * Prompt de vocabulaire pour Whisper, du plus au moins prioritaire : texte du YAML, vocabulaire du
 * serveur, termes des corrections, participants, ordre du jour. Coupé entre deux termes.
 */
export function whisperPrompt(parts: {
  base?: string | undefined;
  vocabulary: readonly string[];
  corrections: readonly string[];
  names: readonly string[];
  agenda: readonly string[];
}): string | undefined {
  const terms = parseVocabulary([...parts.vocabulary, ...correctionTerms(parts.corrections), ...parts.names, ...parts.agenda].join('\n'));
  let prompt = parts.base?.trim() ?? '';
  for (const term of terms) {
    const next = prompt ? `${prompt}${prompt === parts.base?.trim() ? ' ' : ', '}${term}` : term;
    if (next.length > PROMPT_MAX) break;
    prompt = next;
  }
  return prompt.slice(0, PROMPT_MAX) || undefined;
}
