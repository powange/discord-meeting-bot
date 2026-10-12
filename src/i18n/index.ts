import { fr, type Messages } from './fr.js';

export const LOCALES = ['fr'] as const;
export type Locale = (typeof LOCALES)[number];

const catalogs: Record<Locale, Messages> = { fr };

export function messages(locale: string): Messages {
  return catalogs[locale as Locale] ?? fr;
}

export type { Messages };
