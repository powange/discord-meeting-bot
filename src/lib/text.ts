/** Tronque `text` à `max` caractères (ellipse comprise). */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Joint des lignes sans dépasser `max` caractères. Si tout ne tient pas, les lignes en trop
 * sont remplacées par `more(n)` (ex. « … et 3 autres »), qui tient toujours dans la limite.
 */
export function joinLinesWithin(lines: readonly string[], max: number, more: (hidden: number) => string, sep = '\n'): string {
  const full = lines.join(sep);
  if (full.length <= max) return full;
  for (let keep = lines.length - 1; keep >= 0; keep--) {
    const tail = more(lines.length - keep);
    const head = lines.slice(0, keep).map((l) => truncate(l, max));
    const candidate = [...head, tail].join(sep);
    if (candidate.length <= max) return candidate;
  }
  return truncate(more(lines.length), max);
}

/**
 * Regroupe des fragments (ex. mentions) en messages d'au plus `max` caractères.
 * `prefix` (avec son séparateur final, ex. « Rappel : ») ne figure que dans le premier message.
 */
export function chunkJoin(prefix: string, parts: readonly string[], max: number, sep = ' '): string[] {
  const messages: string[] = [];
  let current = prefix;
  let empty = true; // aucun fragment encore ajouté à `current`
  for (const part of parts) {
    const candidate = empty ? current + part : current + sep + part;
    if (candidate.length > max && current.length > 0) {
      messages.push(current);
      current = part;
    } else {
      current = candidate;
    }
    empty = false;
  }
  if (current.length > 0) messages.push(current);
  return messages;
}
