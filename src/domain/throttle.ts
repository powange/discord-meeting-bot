/**
 * Anti-répétition : une même cause n'est signalée qu'une fois par fenêtre (par défaut 1 h).
 * Évite d'inonder le salon d'alertes quand un problème persiste.
 */
export class Throttle {
  private readonly last = new Map<string, number>();

  constructor(private readonly windowMs = 3_600_000) {}

  /** Vrai si la clé peut être signalée maintenant (et l'enregistre). */
  allow(key: string, now = Date.now()): boolean {
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < this.windowMs) return false;
    this.last.set(key, now);
    return true;
  }
}
