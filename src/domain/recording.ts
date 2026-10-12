/** Logique pure de l'enregistrement : nommage des pistes, fin sur vocal vide, bilan de présence. */

/** Chemin relatif d'un segment : `<userId>/<startMs>.ogg` (tri naturel = ordre chronologique). */
export function segmentRelativePath(userId: string, startMs: number): string {
  return `${userId}/${String(startMs).padStart(9, '0')}.ogg`;
}

export interface PresenceInterval {
  userId: string;
  joinedAt: Date;
  leftAt: Date | null;
  excluded: boolean;
}

export interface AttendanceReport {
  /** Inscrits (présent / peut-être) venus. */
  came: string[];
  /** Inscrits « présent » jamais venus. */
  noShow: string[];
  /** Venus sans s'être inscrits (ou inscrits absents). */
  unannounced: string[];
  /** Venus mais non enregistrés (rôle opt-out). */
  notRecorded: string[];
  /** Temps de présence cumulé par personne (ms). */
  presenceMs: Map<string, number>;
}

/** Compare les présences déclarées (RSVP) aux présences réelles dans le vocal. */
export function attendanceReport(
  rsvps: ReadonlyArray<{ userId: string; status: 'yes' | 'maybe' | 'no' }>,
  presence: readonly PresenceInterval[],
  endedAt: Date,
): AttendanceReport {
  const presenceMs = new Map<string, number>();
  const excluded = new Set<string>();
  for (const p of presence) {
    const end = (p.leftAt ?? endedAt).getTime();
    presenceMs.set(p.userId, (presenceMs.get(p.userId) ?? 0) + Math.max(0, end - p.joinedAt.getTime()));
    if (p.excluded) excluded.add(p.userId);
  }
  const attended = new Set(presence.map((p) => p.userId));
  const declared = new Map(rsvps.map((r) => [r.userId, r.status]));
  const order = (ids: Iterable<string>) => [...ids].sort((a, b) => (presenceMs.get(b) ?? 0) - (presenceMs.get(a) ?? 0));

  return {
    came: order([...attended].filter((id) => declared.get(id) === 'yes' || declared.get(id) === 'maybe')),
    noShow: rsvps.filter((r) => r.status === 'yes' && !attended.has(r.userId)).map((r) => r.userId),
    unannounced: order([...attended].filter((id) => !declared.has(id) || declared.get(id) === 'no')),
    notRecorded: order(excluded),
    presenceMs,
  };
}
