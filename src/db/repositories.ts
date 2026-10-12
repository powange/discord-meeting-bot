import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { GuildSeed } from '../config/index.js';
import { reindex } from '../domain/agenda.js';
import type { PlannedJob } from '../domain/reminders.js';
import type { MeetingStatus, RsvpStatus } from '../domain/types.js';
import type { Db } from './client.js';
import {
  agendaItems,
  guildSettings,
  meetings,
  rsvps,
  scheduledJobs,
  type AgendaItemRow,
  type GuildSettingsRow,
  type MeetingRow,
  type RsvpRow,
  type ScheduledJobRow,
} from './schema.js';

type MeetingInsert = typeof meetings.$inferInsert;
type SettingsPatch = Partial<Omit<typeof guildSettings.$inferInsert, 'guildId' | 'createdAt' | 'updatedAt'>>;

export class Repositories {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- guild_settings

  async getSettings(guildId: string, seed: GuildSeed): Promise<GuildSettingsRow> {
    const [existing] = await this.db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
    if (existing) return existing;
    await this.db
      .insert(guildSettings)
      .values({ guildId, ...seed })
      .onConflictDoNothing();
    const [created] = await this.db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
    return created!;
  }

  /** Serveurs dont le forum des réunions est configuré. */
  async listConfiguredGuildIds(): Promise<string[]> {
    const rows = await this.db.select({ id: guildSettings.guildId }).from(guildSettings).where(isNotNull(guildSettings.forumChannelId));
    return rows.map((r) => r.id);
  }

  async listHubThreadIds(): Promise<string[]> {
    const rows = await this.db.select({ id: guildSettings.hubThreadId }).from(guildSettings).where(isNotNull(guildSettings.hubThreadId));
    return rows.map((r) => r.id!);
  }

  async updateSettings(guildId: string, patch: SettingsPatch): Promise<void> {
    await this.db.update(guildSettings).set(patch).where(eq(guildSettings.guildId, guildId));
  }

  // ---------------------------------------------------------------- meetings

  async insertMeeting(values: MeetingInsert): Promise<MeetingRow> {
    const [row] = await this.db.insert(meetings).values(values).returning();
    return row!;
  }

  async getMeeting(id: string): Promise<MeetingRow | undefined> {
    const [row] = await this.db.select().from(meetings).where(eq(meetings.id, id));
    return row;
  }

  async getMeetingByThread(threadId: string): Promise<MeetingRow | undefined> {
    const [row] = await this.db.select().from(meetings).where(eq(meetings.threadId, threadId));
    return row;
  }

  async updateMeeting(id: string, patch: Partial<MeetingInsert>): Promise<MeetingRow | undefined> {
    const [row] = await this.db.update(meetings).set(patch).where(eq(meetings.id, id)).returning();
    return row;
  }

  async listMeetings(guildId: string, statuses: readonly MeetingStatus[]): Promise<MeetingRow[]> {
    return this.db
      .select()
      .from(meetings)
      .where(and(eq(meetings.guildId, guildId), inArray(meetings.status, [...statuses])));
  }

  async deleteMeeting(id: string): Promise<void> {
    await this.db.delete(meetings).where(eq(meetings.id, id));
  }

  /**
   * Changement de statut conditionnel (compare-and-set) : renvoie la ligne si la transition
   * a eu lieu, `undefined` si la réunion n'était plus dans un des statuts `from` (course entre
   * le scheduler et un clic, par exemple).
   */
  async transitionMeeting(
    id: string,
    from: readonly MeetingStatus[],
    to: MeetingStatus,
    patch: Partial<MeetingInsert> = {},
  ): Promise<MeetingRow | undefined> {
    const [row] = await this.db
      .update(meetings)
      .set({ ...patch, status: to })
      .where(and(eq(meetings.id, id), inArray(meetings.status, [...from])))
      .returning();
    return row;
  }

  // ---------------------------------------------------------------- rsvps

  async setRsvp(meetingId: string, userId: string, status: RsvpStatus): Promise<void> {
    await this.db
      .insert(rsvps)
      .values({ meetingId, userId, status })
      .onConflictDoUpdate({ target: [rsvps.meetingId, rsvps.userId], set: { status, updatedAt: new Date() } });
  }

  async listRsvps(meetingId: string): Promise<RsvpRow[]> {
    return this.db.select().from(rsvps).where(eq(rsvps.meetingId, meetingId));
  }

  // ---------------------------------------------------------------- agenda

  async listAgenda(meetingId: string): Promise<AgendaItemRow[]> {
    return this.db
      .select()
      .from(agendaItems)
      .where(eq(agendaItems.meetingId, meetingId))
      .orderBy(asc(agendaItems.position), asc(agendaItems.id));
  }

  /**
   * Ajoute un point en fin de liste. Le verrou sur la réunion sérialise les ajouts concurrents
   * (position et limite de taille cohérentes). `prepare` reçoit le nombre de points actuel et
   * l'état de verrouillage, renvoie le point validé à insérer, ou lève une erreur pour refuser.
   */
  async addAgendaItem(
    meetingId: string,
    authorId: string,
    prepare: (count: number, locked: boolean) => { title: string; detail: string },
  ): Promise<AgendaItemRow> {
    return this.db.transaction(async (tx) => {
      const [meeting] = await tx
        .select({ locked: meetings.agendaLocked })
        .from(meetings)
        .where(eq(meetings.id, meetingId))
        .for('update');
      if (!meeting) throw new Error(`Réunion ${meetingId} introuvable`);
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(agendaItems)
        .where(eq(agendaItems.meetingId, meetingId));
      const item = prepare(count, meeting.locked);
      const [row] = await tx
        .insert(agendaItems)
        .values({ meetingId, position: count, authorId, ...item })
        .returning();
      return row!;
    });
  }

  /** Applique un nouvel ordre (liste complète des ids) et retire les points absents de la liste. */
  async reorderAgenda(meetingId: string, orderedIds: readonly number[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.select({ id: meetings.id }).from(meetings).where(eq(meetings.id, meetingId)).for('update');
      const current = await tx.select({ id: agendaItems.id }).from(agendaItems).where(eq(agendaItems.meetingId, meetingId));
      const keep = new Set(orderedIds);
      const removed = current.map((r) => r.id).filter((id) => !keep.has(id));
      if (removed.length > 0) {
        await tx.delete(agendaItems).where(and(eq(agendaItems.meetingId, meetingId), inArray(agendaItems.id, removed)));
      }
      for (const { id, position } of reindex(orderedIds)) {
        await tx
          .update(agendaItems)
          .set({ position })
          .where(and(eq(agendaItems.meetingId, meetingId), eq(agendaItems.id, id)));
      }
    });
  }

  async copyAgenda(fromMeetingId: string, toMeetingId: string): Promise<void> {
    const items = await this.listAgenda(fromMeetingId);
    if (items.length === 0) return;
    await this.db.insert(agendaItems).values(
      items.map((i, position) => ({ meetingId: toMeetingId, position, title: i.title, detail: i.detail, authorId: i.authorId })),
    );
  }

  // ---------------------------------------------------------------- scheduled_jobs

  /**
   * Remplace les échéances en attente d'une réunion par `planned` (réarme aussi celles déjà
   * exécutées). Une échéance en cours d'exécution (réservée par le scheduler) est conservée :
   * c'est souvent elle qui déclenche la replanification (passage « En cours »).
   */
  async replaceJobs(meetingId: string, planned: readonly PlannedJob[]): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .delete(scheduledJobs)
        .where(
          and(
            eq(scheduledJobs.meetingId, meetingId),
            isNull(scheduledJobs.doneAt),
            or(isNull(scheduledJobs.lockedUntil), lt(scheduledJobs.lockedUntil, now)),
          ),
        );
      if (planned.length === 0) return;
      await tx
        .insert(scheduledJobs)
        .values(planned.map((j) => ({ meetingId, kind: j.kind, offsetMin: j.offsetMin, dueAt: j.dueAt })))
        .onConflictDoUpdate({
          target: [scheduledJobs.meetingId, scheduledJobs.kind, scheduledJobs.offsetMin],
          set: { dueAt: sql`excluded.due_at`, doneAt: null, attempts: 0, lockedUntil: null, lastError: null },
        });
    });
  }

  async cancelPendingJobs(meetingId: string): Promise<void> {
    await this.db.delete(scheduledJobs).where(and(eq(scheduledJobs.meetingId, meetingId), isNull(scheduledJobs.doneAt)));
  }

  /**
   * Réserve les échéances dues (bail de `leaseSec` secondes). `SKIP LOCKED` rend la réservation
   * sûre même si deux instances tournaient par erreur en parallèle.
   */
  async claimDueJobs(now: Date, limit: number, maxAttempts: number, leaseSec = 120): Promise<ScheduledJobRow[]> {
    const result = await this.db.execute<{ id: number }>(sql`
      update ${scheduledJobs}
         set locked_until = ${new Date(now.getTime() + leaseSec * 1000)}, attempts = attempts + 1
       where id in (
         select id from ${scheduledJobs}
          where done_at is null and due_at <= ${now} and attempts < ${maxAttempts}
            and (locked_until is null or locked_until < ${now})
          order by due_at
          limit ${limit}
          for update skip locked)
      returning id`);
    const ids = result.rows.map((r) => r.id);
    if (ids.length === 0) return [];
    return this.db.select().from(scheduledJobs).where(inArray(scheduledJobs.id, ids)).orderBy(asc(scheduledJobs.dueAt));
  }

  async completeJob(id: number): Promise<void> {
    await this.db.update(scheduledJobs).set({ doneAt: new Date(), lockedUntil: null }).where(eq(scheduledJobs.id, id));
  }

  /** Échec : nouvelle tentative après un backoff exponentiel (1, 2, 4… min). */
  async failJob(job: ScheduledJobRow, error: string, now: Date): Promise<void> {
    const backoffMs = 60_000 * 2 ** Math.max(0, job.attempts - 1);
    await this.db
      .update(scheduledJobs)
      .set({ lastError: error.slice(0, 2000), lockedUntil: new Date(now.getTime() + backoffMs) })
      .where(eq(scheduledJobs.id, job.id));
  }
}
