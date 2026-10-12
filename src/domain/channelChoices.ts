/** Liste de salons lisible pour un menu déroulant : « Catégorie › #nom », dans l'ordre du serveur. */

export interface ChannelInfo {
  id: string;
  name: string;
  position: number;
  /** Catégorie parente, null pour un salon hors catégorie (affiché en premier, comme dans Discord). */
  category: { name: string; position: number } | null;
}

export interface ChannelChoice {
  label: string;
  value: string;
}

export interface ChannelPage {
  options: ChannelChoice[];
  page: number;
  pages: number;
}

export const PAGE_SIZE = 25;

export function channelLabel(c: ChannelInfo, prefix = '#'): string {
  const name = `${prefix}${c.name}`;
  const label = c.category ? `${c.category.name} › ${name}` : name;
  return label.length <= 100 ? label : `${label.slice(0, 99)}…`;
}

/** Page `page` (0 = première) de la liste triée ; le salon actuel est remonté sur sa page. */
export function channelPage(channels: readonly ChannelInfo[], page: number, prefix = '#'): ChannelPage {
  const sorted = [...channels].sort(
    (a, b) => (a.category?.position ?? -1) - (b.category?.position ?? -1) || a.position - b.position || a.name.localeCompare(b.name),
  );
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  return {
    options: sorted.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE).map((c) => ({ label: channelLabel(c, prefix), value: c.id })),
    page: p,
    pages,
  };
}

/** Page sur laquelle se trouve un salon (pour ouvrir la liste là où est la valeur actuelle). */
export function pageOf(channels: readonly ChannelInfo[], id: string | null): number {
  if (!id) return 0;
  const sorted = [...channels].sort(
    (a, b) => (a.category?.position ?? -1) - (b.category?.position ?? -1) || a.position - b.position || a.name.localeCompare(b.name),
  );
  const index = sorted.findIndex((c) => c.id === id);
  return index < 0 ? 0 : Math.floor(index / PAGE_SIZE);
}
