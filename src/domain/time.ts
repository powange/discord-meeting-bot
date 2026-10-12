import { DateTime } from 'luxon';

export type ParseResult = { ok: true; value: DateTime } | { ok: false; error: 'format' | 'invalid' };

const DATE_PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray, now: DateTime) => { y: number; mo: number; d: number; yearGiven: boolean } }> = [
  // 15/10/2026, 15-10-2026, 15.10.26
  { re: /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/, build: (m, _n) => ({ d: +m[1]!, mo: +m[2]!, y: normYear(+m[3]!), yearGiven: true }) },
  // 2026-10-15
  { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, build: (m) => ({ y: +m[1]!, mo: +m[2]!, d: +m[3]!, yearGiven: true }) },
  // 15/10 (année déduite)
  { re: /^(\d{1,2})[/.-](\d{1,2})$/, build: (m, n) => ({ d: +m[1]!, mo: +m[2]!, y: n.year, yearGiven: false }) },
];

// 18:30, 18h30, 18h, 18H, 18
const TIME_RE = /^(\d{1,2})(?:\s*[:hH]\s*(\d{2})?)?$/;

function normYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

/**
 * Analyse une saisie libre « date heure » (ex. `15/10/2026 18:30`, `15/10 18h`, `2026-10-15 9h15`)
 * dans le fuseau `zone`. Sans année, on prend la prochaine occurrence à partir de `now`.
 */
export function parseDateTime(input: string, zone: string, now: DateTime): ParseResult {
  const parts = input.trim().replace(/\s+(à|a)\s+/i, ' ').split(/\s+/);
  if (parts.length !== 2) return { ok: false, error: 'format' };
  const [datePart, timePart] = parts as [string, string];

  const timeMatch = TIME_RE.exec(timePart);
  if (!timeMatch) return { ok: false, error: 'format' };
  const hour = +timeMatch[1]!;
  const minute = timeMatch[2] ? +timeMatch[2] : 0;

  const nowInZone = now.setZone(zone);
  for (const { re, build } of DATE_PATTERNS) {
    const m = re.exec(datePart);
    if (!m) continue;
    const { y, mo, d, yearGiven } = build(m, nowInZone);
    let dt = DateTime.fromObject({ year: y, month: mo, day: d, hour, minute }, { zone });
    if (!dt.isValid || dt.hour !== hour || dt.minute !== minute) return { ok: false, error: 'invalid' };
    if (!yearGiven && dt < nowInZone.minus({ days: 1 })) dt = dt.plus({ years: 1 });
    if (!dt.isValid) return { ok: false, error: 'invalid' };
    return { ok: true, value: dt };
  }
  return { ok: false, error: 'format' };
}

/** Format de saisie canonique, utilisé pour pré-remplir les formulaires. */
export function formatDateTimeInput(date: Date, zone: string): string {
  return DateTime.fromJSDate(date, { zone }).toFormat('dd/MM/yyyy HH:mm');
}

/** Timestamp Discord (`<t:…:F>`), affiché dans le fuseau de chaque lecteur. */
export function discordTimestamp(date: Date, style: 'F' | 'f' | 'R' | 't' | 'D' | 'd' = 'F'): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}
