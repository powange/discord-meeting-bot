/**
 * Avertissement des arrivants pendant un enregistrement : une seule fois par personne et par
 * session, jamais pour ceux déjà prévenus au démarrage ni pour ceux qui ne sont pas enregistrés.
 */
export class ArrivalNotices {
  private readonly notified = new Set<string>();

  constructor(alreadyWarned: Iterable<string> = []) {
    for (const id of alreadyWarned) this.notified.add(id);
  }

  /** Vrai s'il faut prévenir cette personne (et la marque comme prévenue). */
  shouldNotify(userId: string, recorded: boolean): boolean {
    if (!recorded || this.notified.has(userId)) return false;
    this.notified.add(userId);
    return true;
  }
}

/** Pseudo du bot pendant un enregistrement (limite Discord : 32 caractères). */
export const RECORDING_NICKNAME = '🔴 Enregistrement';
