import type { Rsvp, RsvpStatus } from './types.js';

export type RsvpGroups = Record<RsvpStatus, string[]>;

/** Regroupe les réponses par statut, dans l'ordre chronologique de réponse. */
export function groupRsvps(rsvps: readonly Rsvp[]): RsvpGroups {
  const groups: RsvpGroups = { yes: [], maybe: [], no: [] };
  for (const r of [...rsvps].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())) {
    groups[r.status].push(r.userId);
  }
  return groups;
}

/** Personnes à mentionner dans un rappel : présents puis « peut-être ». */
export function reminderTargets(rsvps: readonly Rsvp[]): string[] {
  const g = groupRsvps(rsvps);
  return [...g.yes, ...g.maybe];
}

/** Membres attendus (ex. membres d'un rôle) n'ayant pas encore répondu. */
export function nonResponders(expected: Iterable<string>, rsvps: readonly Rsvp[], exclude: readonly string[] = []): string[] {
  const answered = new Set(rsvps.map((r) => r.userId));
  const excluded = new Set(exclude);
  return [...new Set(expected)].filter((id) => !answered.has(id) && !excluded.has(id));
}

/**
 * Rôles relancés : ceux invités pour cette réunion, sinon le rôle de relance du serveur ; aucun
 * si « Personne » a été choisi.
 */
export function nudgeRoles(meeting: { targetRoleIds: readonly string[]; inviteNone?: boolean }, settings: { nudgeRoleId: string | null }): string[] {
  if (meeting.inviteNone) return [];
  if (meeting.targetRoleIds.length) return [...meeting.targetRoleIds];
  return settings.nudgeRoleId ? [settings.nudgeRoleId] : [];
}
