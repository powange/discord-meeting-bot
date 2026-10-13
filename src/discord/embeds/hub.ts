import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { encode } from '../../domain/customId.js';
import { discordTimestamp } from '../../domain/time.js';
import type { MeetingStatus } from '../../domain/types.js';
import type { Messages } from '../../i18n/index.js';
import { joinLinesWithin, truncate } from '../../lib/text.js';
import { consentButton } from './meetingManager.js';
import type { RenderedMessage } from './meetingCard.js';

export interface HubMeeting {
  threadId: string;
  startsAt: Date;
  status: MeetingStatus;
}

/** Message du post épinglé : mode d'emploi, prochaines réunions, bouton de création. */
export function renderHub(
  upcoming: readonly HubMeeting[],
  m: Messages,
  recent: ReadonlyArray<{ title: string; startsAt: Date; url: string }> = [],
  /** Sondages de date en cours : post et fin des réponses. */
  polls: ReadonlyArray<{ threadId: string; closesAt: Date | null }> = [],
): RenderedMessage {
  const lines = [...upcoming]
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .map((meeting) => {
      const live = meeting.status === 'live' ? ` · 🟢 **${m.hub.live}**` : '';
      return `${discordTimestamp(meeting.startsAt, 'f')} · <#${meeting.threadId}>${live}`;
    });

  const embed = new EmbedBuilder()
    .setTitle(m.hub.title)
    .setColor(0x5865f2)
    .setDescription(m.hub.intro)
    .addFields({ name: m.hub.upcoming, value: lines.length > 0 ? joinLinesWithin(lines, 1024, m.card.more) : m.hub.none });
  if (polls.length > 0) {
    const lines = polls.map((p) => `<#${p.threadId}>${p.closesAt ? ` · ${discordTimestamp(p.closesAt, 'R')}` : ''}`);
    embed.addFields({ name: `🗳️ ${m.datePoll.hubSection}`, value: joinLinesWithin(lines, 1024, m.card.more) });
  }
  if (recent.length > 0) {
    const reports = recent.map((r) => `${discordTimestamp(r.startsAt, 'd')} · [${truncate(r.title.replace(/[[\]]/g, ''), 80)}](${r.url})`);
    embed.addFields({ name: m.hub.recentReports, value: joinLinesWithin(reports, 1024, m.card.more) });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(encode({ type: 'meeting.create' })).setLabel(m.hub.create).setEmoji('📅').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(encode({ type: 'poll.create' })).setLabel(m.datePoll.hubButton).setEmoji('🗳️').setStyle(ButtonStyle.Secondary),
    consentButton(m),
  );
  return { embeds: [embed.toJSON()], components: [row.toJSON()] };
}
