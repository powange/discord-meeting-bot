import { EmbedBuilder, type APIEmbed } from 'discord.js';
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
}

const BAR_LENGTH = 10;

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
      };
    })
    .sort((a, b) => b.speechMs - a.speechMs || b.presenceMs - a.presenceMs);
}

/** `▰▰▰▱▱▱▱▱▱▱` proportionnel à `pct`. */
export function bar(pct: number, length = BAR_LENGTH): string {
  const filled = Math.max(0, Math.min(length, Math.round((pct / 100) * length)));
  return '▰'.repeat(filled) + '▱'.repeat(length - filled);
}

/** Bilan de fin d'enregistrement : participation de chacun et présences déclarées vs réelles. */
export function renderRecordingSummary(input: SummaryInput, m: Messages): APIEmbed {
  const s = m.summary;
  const stats = participantStats(input);
  const durationMs = input.endedAt.getTime() - input.startedAt.getTime();
  const lines = stats.map((p) => {
    const who = `<@${p.userId}>${p.registered ? '' : ` *(${s.unannounced})*`}`;
    return p.recorded
      ? s.participantLine(who, bar(p.speechPct), m.format.duration(p.speechMs), p.speechPct, m.format.duration(p.presenceMs), p.presencePct)
      : s.notRecordedLine(who, m.format.duration(p.presenceMs), p.presencePct);
  });
  const noShow = attendanceReport(input.rsvps, input.presence, input.endedAt).noShow;

  const embed = new EmbedBuilder()
    .setTitle(s.title)
    .setColor(0x95a5a6)
    .setDescription(
      s.header(
        input.reason.charAt(0).toUpperCase() + input.reason.slice(1),
        discordTimestamp(input.startedAt, 't'),
        discordTimestamp(input.endedAt, 't'),
        m.format.duration(durationMs),
        input.segments.length,
      ),
    )
    .addFields({ name: s.participants(stats.length), value: lines.length ? joinLinesWithin(lines, 1024, m.card.more) : s.nobody });
  if (noShow.length > 0) {
    embed.addFields({ name: s.noShow(noShow.length), value: joinLinesWithin(noShow.map((id) => `<@${id}>`), 1024, m.card.more, ' ') });
  }
  return embed.toJSON();
}
