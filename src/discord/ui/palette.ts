import type { MeetingStatus } from '../../domain/types.js';

/**
 * Couleurs d'accent, une par sens (aucune valeur hexadécimale ailleurs) :
 * - brand : information, neutre (réunion à venir, panneaux, compte rendu, bilan) ;
 * - live : maintenant, ou réussi (réunion en cours, traitement terminé, succès) ;
 * - pending : quelqu'un ou quelque chose doit encore agir (sondage, traitement en cours) ;
 * - warning : interrompu, reprise possible ;
 * - danger : échec, annulé, ou enregistrement actif (convention « REC ») ; jamais un état normal ;
 * - muted : passé, figé, inactif.
 */
export const Accent = {
  brand: 0x5865f2,
  live: 0x57f287,
  pending: 0xfee75c,
  warning: 0xe67e22,
  danger: 0xed4245,
  muted: 0x95a5a6,
} as const;

/** Couleur d'une réunion selon son statut. */
export function statusAccent(status: MeetingStatus): number {
  switch (status) {
    case 'scheduled':
      return Accent.brand;
    case 'live':
      return Accent.live;
    case 'polling':
      return Accent.pending;
    case 'cancelled':
      return Accent.danger;
    default:
      return Accent.muted;
  }
}
