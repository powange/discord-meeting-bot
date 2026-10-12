import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { JOB_KINDS, MEETING_STATUSES, RECORDING_STATUSES, RSVP_STATUSES, type StatusTagIds } from '../domain/types.js';

const tz = (name?: string) => (name ? timestamp(name, { withTimezone: true }) : timestamp({ withTimezone: true }));
const createdAt = () => tz().notNull().defaultNow();
const updatedAt = () =>
  tz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const meetingStatus = pgEnum('meeting_status', MEETING_STATUSES);
export const rsvpStatus = pgEnum('rsvp_status', RSVP_STATUSES);
export const jobKind = pgEnum('job_kind', JOB_KINDS);
export const recordingStatus = pgEnum('recording_status', RECORDING_STATUSES);

/** Réglages Discord d'un serveur, modifiés via /config. */
export const guildSettings = pgTable('guild_settings', {
  guildId: text().primaryKey(),
  forumChannelId: text(),
  /** Post épinglé du forum : bouton « Nouvelle réunion » et liste des prochaines réunions. */
  hubThreadId: text(),
  /** Si renseigné, toutes les réunions se tiennent dans ce salon vocal (pas de choix à la création). */
  voiceChannelId: text(),
  tagIds: jsonb().$type<StatusTagIds>(),
  managerRoleId: text(),
  optoutRoleId: text(),
  /** Si renseigné, ses membres sans réponse sont relancés avec le premier rappel. */
  nudgeRoleId: text(),
  creatorsRestricted: boolean().notNull().default(false),
  timezone: text().notNull(),
  locale: text().notNull(),
  reminderOffsetsMin: integer().array().notNull(),
  defaultDurationMin: integer().notNull(),
  autoRecordDefault: boolean().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const meetings = pgTable(
  'meetings',
  {
    id: uuid().primaryKey().defaultRandom(),
    guildId: text().notNull(),
    /** Post du forum ; null le temps de la création. Son id est aussi celui du premier message (la carte). */
    threadId: text().unique(),
    /** Second message du post, dédié à l'ordre du jour. */
    agendaMessageId: text(),
    scheduledEventId: text(),
    voiceChannelId: text().notNull(),
    title: text().notNull(),
    description: text().notNull().default(''),
    startsAt: tz().notNull(),
    durationMin: integer().notNull(),
    organizerId: text().notNull(),
    status: meetingStatus().notNull().default('scheduled'),
    autoRecord: boolean().notNull().default(false),
    agendaLocked: boolean().notNull().default(false),
    startedAt: tz(),
    endedAt: tz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.guildId, t.startsAt)],
);

export const rsvps = pgTable(
  'rsvps',
  {
    meetingId: uuid()
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    userId: text().notNull(),
    status: rsvpStatus().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.meetingId, t.userId] })],
);

export const agendaItems = pgTable(
  'agenda_items',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    meetingId: uuid()
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    title: text().notNull(),
    detail: text().notNull().default(''),
    authorId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.meetingId, t.position)],
);

/** Échéances (rappels, début, clôture auto) : la BDD est la source de vérité du scheduler. */
export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    meetingId: uuid()
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    kind: jobKind().notNull(),
    offsetMin: integer().notNull().default(0),
    dueAt: tz().notNull(),
    doneAt: tz(),
    attempts: integer().notNull().default(0),
    lockedUntil: tz(),
    lastError: text(),
  },
  (t) => [
    unique().on(t.meetingId, t.kind, t.offsetMin),
    index('scheduled_jobs_pending_idx').on(t.dueAt).where(sql`${t.doneAt} is null`),
  ],
);

/** Une session d'enregistrement (une réunion peut en avoir plusieurs : reprise après coupure). */
export const recordings = pgTable(
  'recordings',
  {
    id: uuid().primaryKey().defaultRandom(),
    meetingId: uuid()
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    guildId: text().notNull(),
    voiceChannelId: text().notNull(),
    /** null = démarrage automatique. */
    startedBy: text(),
    startedAt: tz().notNull(),
    endedAt: tz(),
    status: recordingStatus().notNull().default('recording'),
    stopReason: text(),
    /** Dossier local des pistes de cette session. */
    dataDir: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.meetingId), index().on(t.status)],
);

/** Présence réelle dans le vocal pendant l'enregistrement (une ligne par passage). */
export const recordingPresence = pgTable(
  'recording_presence',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    recordingId: uuid()
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    userId: text().notNull(),
    displayName: text().notNull(),
    joinedAt: tz().notNull(),
    leftAt: tz(),
    /** Rôle « ne pas m'enregistrer » : présence notée, voix jamais enregistrée. */
    excluded: boolean().notNull().default(false),
  },
  (t) => [index().on(t.recordingId)],
);

/** Une prise de parole = un fichier OGG/Opus 48 kHz. Les temps sont relatifs au début de la session. */
export const audioSegments = pgTable(
  'audio_segments',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    recordingId: uuid()
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    userId: text().notNull(),
    startMs: integer().notNull(),
    endMs: integer().notNull(),
    packets: integer().notNull(),
    filePath: text().notNull(),
  },
  (t) => [index().on(t.recordingId, t.userId, t.startMs)],
);

export type RecordingRow = typeof recordings.$inferSelect;
export type RecordingPresenceRow = typeof recordingPresence.$inferSelect;
export type AudioSegmentRow = typeof audioSegments.$inferSelect;
export type GuildSettingsRow = typeof guildSettings.$inferSelect;
export type MeetingRow = typeof meetings.$inferSelect;
export type AgendaItemRow = typeof agendaItems.$inferSelect;
export type RsvpRow = typeof rsvps.$inferSelect;
export type ScheduledJobRow = typeof scheduledJobs.$inferSelect;
