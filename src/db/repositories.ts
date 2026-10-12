import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { GuildSeed } from '../config/index.js';
import { reindex } from '../domain/agenda.js';
import type { PlannedJob } from '../domain/reminders.js';
import { PIPELINE_STEPS, type MeetingStatus, type PipelineStep, type RsvpStatus } from '../domain/types.js';
import type { Db } from './client.js';
import {
  agendaItems,
  audioSegments,
  pipelineSteps,
  summaries,
  transcriptionBackends,
  transcriptionBlocks,
  transcriptSegments,
  recordingPresence,
  recordings,
  guildSettings,
  meetings,
  rsvps,
  scheduledJobs,
  type AgendaItemRow,
  type PipelineStepRow,
  type SummaryRow,
  type TranscriptionBackendRow,
  type TranscriptionBlockRow,
  type TranscriptSegmentRow,
  type AudioSegmentRow,
  type RecordingPresenceRow,
  type RecordingRow,
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

  /** Réglages sans création (lecture seule). */
  async getSettingsIfExists(guildId: string): Promise<GuildSettingsRow | undefined> {
    const [row] = await this.db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
    return row;
  }

  async listAlertChannels(): Promise<string[]> {
    const rows = await this.db.select({ id: guildSettings.alertChannelId }).from(guildSettings).where(isNotNull(guildSettings.alertChannelId));
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

  /** Réunions à venir ou en cours, tous serveurs confondus. */
  async listOpenMeetings(): Promise<MeetingRow[]> {
    return this.db.select().from(meetings).where(inArray(meetings.status, ['scheduled', 'live']));
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

  // ---------------------------------------------------------------- recordings

  async insertRecording(values: typeof recordings.$inferInsert): Promise<RecordingRow> {
    const [row] = await this.db.insert(recordings).values(values).returning();
    return row!;
  }

  async updateRecording(id: string, patch: Partial<typeof recordings.$inferInsert>): Promise<void> {
    await this.db.update(recordings).set(patch).where(eq(recordings.id, id));
  }

  async getRecording(id: string): Promise<RecordingRow | undefined> {
    const [row] = await this.db.select().from(recordings).where(eq(recordings.id, id));
    return row;
  }

  async getActiveRecording(meetingId: string): Promise<RecordingRow | undefined> {
    const [row] = await this.db
      .select()
      .from(recordings)
      .where(and(eq(recordings.meetingId, meetingId), eq(recordings.status, 'recording')));
    return row;
  }

  async listRecordingsByStatus(status: RecordingRow['status']): Promise<RecordingRow[]> {
    return this.db.select().from(recordings).where(eq(recordings.status, status));
  }

  async insertPresence(values: typeof recordingPresence.$inferInsert): Promise<void> {
    await this.db.insert(recordingPresence).values(values);
  }

  /** Clôt le passage en cours d'un participant (ou de tous si `userId` est omis). */
  async closePresence(recordingId: string, at: Date, userId?: string): Promise<void> {
    await this.db
      .update(recordingPresence)
      .set({ leftAt: at })
      .where(
        and(
          eq(recordingPresence.recordingId, recordingId),
          isNull(recordingPresence.leftAt),
          userId ? eq(recordingPresence.userId, userId) : undefined,
        ),
      );
  }

  async listPresence(recordingId: string): Promise<RecordingPresenceRow[]> {
    return this.db.select().from(recordingPresence).where(eq(recordingPresence.recordingId, recordingId)).orderBy(asc(recordingPresence.joinedAt));
  }

  async insertSegment(values: typeof audioSegments.$inferInsert): Promise<void> {
    await this.db.insert(audioSegments).values(values);
  }

  async listSegments(recordingId: string): Promise<AudioSegmentRow[]> {
    return this.db
      .select()
      .from(audioSegments)
      .where(eq(audioSegments.recordingId, recordingId))
      .orderBy(asc(audioSegments.userId), asc(audioSegments.startMs));
  }

  async listRecordingsForMeeting(meetingId: string): Promise<RecordingRow[]> {
    return this.db.select().from(recordings).where(eq(recordings.meetingId, meetingId)).orderBy(asc(recordings.startedAt));
  }

  /** Dernier nom affiché connu de chaque participant enregistré (pour la transcription). */
  async displayNamesForMeeting(meetingId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ userId: recordingPresence.userId, name: recordingPresence.displayName })
      .from(recordingPresence)
      .innerJoin(recordings, eq(recordings.id, recordingPresence.recordingId))
      .where(eq(recordings.meetingId, meetingId))
      .orderBy(asc(recordingPresence.joinedAt));
    return new Map(rows.map((r) => [r.userId, r.name]));
  }

  // ---------------------------------------------------------------- pipeline

  /** Crée les étapes manquantes (en attente) ; les étapes existantes ne sont pas touchées. */
  async ensurePipeline(meetingId: string): Promise<void> {
    await this.db
      .insert(pipelineSteps)
      .values(PIPELINE_STEPS.map((step) => ({ meetingId, step })))
      .onConflictDoNothing();
  }

  async listPipeline(meetingId: string): Promise<PipelineStepRow[]> {
    const rows = await this.db.select().from(pipelineSteps).where(eq(pipelineSteps.meetingId, meetingId));
    return rows.sort((a, b) => PIPELINE_STEPS.indexOf(a.step) - PIPELINE_STEPS.indexOf(b.step));
  }

  async updateStep(meetingId: string, step: PipelineStep, patch: Partial<typeof pipelineSteps.$inferInsert>): Promise<void> {
    await this.db
      .update(pipelineSteps)
      .set(patch)
      .where(and(eq(pipelineSteps.meetingId, meetingId), eq(pipelineSteps.step, step)));
  }

  /** Remet en attente les étapes données (relance). */
  async resetSteps(meetingId: string, steps: readonly PipelineStep[]): Promise<void> {
    if (steps.length === 0) return;
    await this.db
      .update(pipelineSteps)
      .set({ status: 'pending', error: null, startedAt: null, finishedAt: null })
      .where(and(eq(pipelineSteps.meetingId, meetingId), inArray(pipelineSteps.step, [...steps])));
  }

  /** Réunions dont le traitement n'est pas terminé (reprise au démarrage). */
  async listUnfinishedPipelines(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ meetingId: pipelineSteps.meetingId })
      .from(pipelineSteps)
      .where(inArray(pipelineSteps.status, ['pending', 'running']));
    return rows.map((r) => r.meetingId);
  }

  // ---------------------------------------------------------------- transcription

  /** Enregistre les blocs (idempotent : un bloc existant n'est pas recréé) et renvoie tous ceux de la réunion. */
  async upsertBlocks(meetingId: string, blocks: ReadonlyArray<Omit<typeof transcriptionBlocks.$inferInsert, 'meetingId'>>): Promise<TranscriptionBlockRow[]> {
    if (blocks.length > 0) {
      await this.db
        .insert(transcriptionBlocks)
        .values(blocks.map((b) => ({ ...b, meetingId })))
        .onConflictDoNothing();
    }
    return this.db.select().from(transcriptionBlocks).where(eq(transcriptionBlocks.meetingId, meetingId)).orderBy(asc(transcriptionBlocks.startMs));
  }

  async segmentsByIds(ids: readonly number[]) {
    if (ids.length === 0) return [];
    return this.db.select().from(audioSegments).where(inArray(audioSegments.id, [...ids])).orderBy(asc(audioSegments.startMs));
  }

  /** Enregistre le texte d'un bloc et le marque traité (transaction : pas de bloc à moitié écrit). */
  async completeBlock(blockId: number, meetingId: string, lines: ReadonlyArray<Omit<typeof transcriptSegments.$inferInsert, 'meetingId' | 'blockId'>>, backend: string, model: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(transcriptSegments).where(eq(transcriptSegments.blockId, blockId));
      if (lines.length > 0) await tx.insert(transcriptSegments).values(lines.map((l) => ({ ...l, meetingId, blockId })));
      await tx.update(transcriptionBlocks).set({ done: true, backend, model }).where(eq(transcriptionBlocks.id, blockId));
    });
  }

  /** Oublie la transcription d'une réunion (retranscription complète). */
  async resetTranscription(meetingId: string): Promise<void> {
    await this.db.delete(transcriptionBlocks).where(eq(transcriptionBlocks.meetingId, meetingId));
  }

  async listTranscript(meetingId: string): Promise<TranscriptSegmentRow[]> {
    return this.db.select().from(transcriptSegments).where(eq(transcriptSegments.meetingId, meetingId)).orderBy(asc(transcriptSegments.startAt));
  }

  async saveSummary(values: typeof summaries.$inferInsert): Promise<void> {
    const { meetingId, ...rest } = values;
    await this.db.insert(summaries).values(values).onConflictDoUpdate({ target: summaries.meetingId, set: { ...rest, createdAt: new Date() } });
  }

  async getSummary(meetingId: string): Promise<SummaryRow | undefined> {
    const [row] = await this.db.select().from(summaries).where(eq(summaries.meetingId, meetingId));
    return row;
  }

  // ---------------------------------------------------------------- serveurs de transcription

  async listBackends(guildId: string): Promise<TranscriptionBackendRow[]> {
    return this.db.select().from(transcriptionBackends).where(eq(transcriptionBackends.guildId, guildId)).orderBy(asc(transcriptionBackends.position));
  }

  /** Ajoute en fin de liste (priorité la plus basse). */
  async addBackend(values: Omit<typeof transcriptionBackends.$inferInsert, 'position' | 'id' | 'createdAt'>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transcriptionBackends)
        .where(eq(transcriptionBackends.guildId, values.guildId));
      await tx.insert(transcriptionBackends).values({ ...values, position: n });
    });
  }

  async updateBackend(guildId: string, name: string, patch: Partial<typeof transcriptionBackends.$inferInsert>): Promise<boolean> {
    const rows = await this.db
      .update(transcriptionBackends)
      .set(patch)
      .where(and(eq(transcriptionBackends.guildId, guildId), eq(transcriptionBackends.name, name)))
      .returning({ id: transcriptionBackends.id });
    return rows.length > 0;
  }

  /** Retire un serveur et recompacte les priorités. */
  async removeBackend(guildId: string, name: string): Promise<boolean> {
    const remaining = (await this.listBackends(guildId)).filter((b) => b.name !== name);
    const deleted = await this.db
      .delete(transcriptionBackends)
      .where(and(eq(transcriptionBackends.guildId, guildId), eq(transcriptionBackends.name, name)))
      .returning({ id: transcriptionBackends.id });
    await this.reorderBackends(guildId, remaining.map((b) => b.name));
    return deleted.length > 0;
  }

  /** Applique un ordre de priorité (liste complète des noms). */
  async reorderBackends(guildId: string, names: readonly string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const [position, name] of names.entries()) {
        await tx
          .update(transcriptionBackends)
          .set({ position })
          .where(and(eq(transcriptionBackends.guildId, guildId), eq(transcriptionBackends.name, name)));
      }
    });
  }

  async getBackend(guildId: string, id: number): Promise<TranscriptionBackendRow | undefined> {
    const [row] = await this.db
      .select()
      .from(transcriptionBackends)
      .where(and(eq(transcriptionBackends.guildId, guildId), eq(transcriptionBackends.id, id)));
    return row;
  }

  // ---------------------------------------------------------------- rétention

  /** Sessions terminées et non purgées, avec ce qu'il faut pour décider de la purge. */
  async listRawPurgeCandidates() {
    const recs = await this.db
      .select({
        recordingId: recordings.id,
        meetingId: recordings.meetingId,
        guildId: recordings.guildId,
        dataDir: recordings.dataDir,
        endedAt: recordings.endedAt,
        purgedAt: recordings.purgedAt,
        meetingStatus: meetings.status,
      })
      .from(recordings)
      .innerJoin(meetings, eq(meetings.id, recordings.meetingId))
      .where(and(isNull(recordings.purgedAt), isNotNull(recordings.endedAt)));
    const out = [];
    for (const r of recs) {
      const steps = await this.listPipeline(r.meetingId);
      const [{ n } = { n: 0 }] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(audioSegments)
        .where(eq(audioSegments.recordingId, r.recordingId));
      out.push({
        ...r,
        mix: steps.find((x) => x.step === 'mix')?.status ?? null,
        transcribe: steps.find((x) => x.step === 'transcribe')?.status ?? null,
        hasSegments: n > 0,
      });
    }
    return out;
  }

  async markRecordingPurged(id: string, at: Date): Promise<void> {
    await this.db.update(recordings).set({ purgedAt: at }).where(eq(recordings.id, id));
  }

  /** Étapes « mix » terminées (audio complet local), avec le serveur de la réunion. */
  async listMixOutputs() {
    return this.db
      .select({ meetingId: pipelineSteps.meetingId, guildId: meetings.guildId, finishedAt: pipelineSteps.finishedAt, output: pipelineSteps.output })
      .from(pipelineSteps)
      .innerJoin(meetings, eq(meetings.id, pipelineSteps.meetingId))
      .where(and(eq(pipelineSteps.step, 'mix'), eq(pipelineSteps.status, 'done')));
  }

  async markMixPurged(meetingId: string, output: Record<string, unknown>, at: Date): Promise<void> {
    await this.updateStep(meetingId, 'mix', { output: { ...output, purgedAt: at.toISOString() } });
  }
}
