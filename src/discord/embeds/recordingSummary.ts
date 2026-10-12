import {
  ContainerBuilder,
  SeparatorSpacingSize,
  type ActionRowBuilder,
  type APIContainerComponent,
  type ButtonBuilder,
} from 'discord.js';
import { captureWarning, type CaptureCounts } from '../../domain/capture.js';
import { attendanceReport, type PresenceInterval } from '../../domain/recording.js';
import { discordTimestamp } from '../../domain/time.js';
import type { RsvpStatus } from '../../domain/types.js';
import type { Messages } from '../../i18n/index.js';
import { joinLinesWithin } from '../../lib/text.js';

export interface SummaryInput {
  reason: string;
  startedAt: Date;
  endedAt: Date;
  segments: ReadonlyArray<{ userId: string; startMs: number; endMs: number }>;
  presence: readonly PresenceInterval[];
  rsvps: ReadonlyArray<{ userId: string; status: RsvpStatus }>;
  /** Qualité de capture par personne (optionnel). */
  capture?: ReadonlyArray<{ userId: string } & CaptureCounts>;
}

export interface ParticipantStats {
  userId: string;
  speechMs: number;
  /** Part du temps de parole total (0-100). */
  speechPct: number;
  presenceMs: number;
  /** Part de la durée de l'enregistrement (0-100). */
  presencePct: number;
  recorded: boolean;
  registered: boolean;
  /** Pourcentage d'audio perdu à signaler, ou null. */
  lossPct: number | null;
}

const BAR_LENGTH = 5;
/** Une couleur par participant (dans l'ordre du classement), comme des tuiles. */
const BAR_COLORS = ['🟦', '🟩', '🟨', '🟪', '🟧', '🟥', '🟫'];
const BAR_EMPTY = '⬛';
/** Les Components V2 limitent le texte total d'un message à 4000 caractères. */
const PARTICIPANTS_BUDGET = 3000;

/** Statistiques par participant, triées par temps de parole décroissant. */
export function participantStats(input: SummaryInput): ParticipantStats[] {
  const durationMs = Math.max(1, input.endedAt.getTime() - input.startedAt.getTime());
  const report = attendanceReport(input.rsvps, input.presence, input.endedAt);
  const speech = new Map<string, number>();
  for (const s of input.segments) speech.set(s.userId, (speech.get(s.userId) ?? 0) + Math.max(0, s.endMs - s.startMs));
  const totalSpeech = [...speech.values()].reduce((a, b) => a + b, 0);
  const excluded = new Set(report.notRecorded);
  const registered = new Set(input.rsvps.filter((r) => r.status !== 'no').map((r) => r.userId));
  const users = new Set([...report.presenceMs.keys(), ...speech.keys()]);

  return [...users]
    .map((userId) => {
      const speechMs = speech.get(userId) ?? 0;
      const presenceMs = Math.min(durationMs, report.presenceMs.get(userId) ?? 0);
      return {
        userId,
        speechMs,
        speechPct: totalSpeech > 0 ? Math.round((speechMs / totalSpeech) * 100) : 0,
        presenceMs,
        presencePct: Math.round((presenceMs / durationMs) * 100),
        recorded: !excluded.has(userId),
        registered: registered.has(userId),
        lossPct: (() => {
          const c = input.capture?.find((x) => x.userId === userId);
          return c ? captureWarning(c) : null;
        })(),
      };
    })
    .sort((a, b) => b.speechMs - a.speechMs || b.presenceMs - a.presenceMs);
}

/** Barre de carrés emoji proportionnelle à `pct` (ex. 🟦🟦🟦⬛⬛), couleur selon le rang. */
export function bar(pct: number, rank = 0, length = BAR_LENGTH): string {
  const filled = Math.max(0, Math.min(length, Math.round((pct / 100) * length)));
  return BAR_COLORS[rank % BAR_COLORS.length]!.repeat(filled) + BAR_EMPTY.repeat(length - filled);
}

export interface SummaryOptions {
  meetingTitle: string;
  interrupted: boolean;
  /** Bouton « Reprendre l'enregistrement » (session interrompue, réunion encore ouverte). */
  resumeButton?: ButtonBuilder;
}

/**
 * Bilan de fin d'enregistrement, en Components V2 (bloc encadré) : il préfigure le compte rendu
 * que les phases 3 et 4 compléteront (résumé, décisions, actions, audio, liens).
 */
export function renderRecordingSummary(input: SummaryInput, options: SummaryOptions, m: Messages): APIContainerComponent {
  const s = m.summary;
  const stats = participantStats(input);
  const durationMs = input.endedAt.getTime() - input.startedAt.getTime();
  const reason = input.reason.charAt(0).toUpperCase() + input.reason.slice(1);

  const container = new ContainerBuilder()
    .setAccentColor(options.interrupted ? 0xe67e22 : 0x57f287)
    .addTextDisplayComponents((t) =>
      t.setContent(
        `${s.title(options.meetingTitle)}\n${s.subtitle(
          options.interrupted ? s.status.interrupted : s.status.stopped,
          reason,
          discordTimestamp(input.startedAt, 't'),
          discordTimestamp(input.endedAt, 't'),
          m.format.duration(durationMs),
          stats.length,
          input.segments.length,
        )}`,
      ),
    )
    .addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Large));

  const lines = stats.map((p, rank) => {
    const who = `<@${p.userId}>${p.registered ? '' : ` *(${s.unannounced})*`}`;
    if (!p.recorded) return s.notRecorded(who, m.format.duration(p.presenceMs), p.presencePct);
    const line = s.participant(who, p.speechPct, bar(p.speechPct, rank), m.format.duration(p.speechMs), m.format.duration(p.presenceMs), p.presencePct);
    return p.lossPct === null ? line : `${line}\n-# ${s.lossWarning(p.lossPct)}`;
  });
  container.addTextDisplayComponents((t) =>
    t.setContent(`${s.participation}\n${lines.length ? joinLinesWithin(lines, PARTICIPANTS_BUDGET, m.card.more) : s.nobody}`),
  );

  const noShow = attendanceReport(input.rsvps, input.presence, input.endedAt).noShow;
  if (noShow.length > 0) {
    container
      .addSeparatorComponents((sep) => sep.setDivider(false))
      .addTextDisplayComponents((t) => t.setContent(`${s.noShow}\n${joinLinesWithin(noShow.map((id) => `<@${id}>`), 500, m.card.more, ' ')}`));
  }
  if (lines.length > 0) container.addTextDisplayComponents((t) => t.setContent(s.footnote));

  if (options.interrupted) {
    container.addSeparatorComponents((sep) => sep).addTextDisplayComponents((t) => t.setContent(m.recording.interrupted));
    if (options.resumeButton) container.addActionRowComponents((row: ActionRowBuilder<ButtonBuilder>) => row.addComponents(options.resumeButton!));
  }
  return container.toJSON();
}
