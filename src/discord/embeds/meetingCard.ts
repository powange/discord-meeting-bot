import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIEmbed,
} from 'discord.js';
import { encode } from '../../domain/customId.js';
import { isOpen } from '../../domain/meeting.js';
import { groupRsvps } from '../../domain/rsvp.js';
import { discordTimestamp } from '../../domain/time.js';
import type { AgendaItem, MeetingStatus, Rsvp } from '../../domain/types.js';
import type { Messages } from '../../i18n/index.js';
import { joinLinesWithin, truncate } from '../../lib/text.js';

export interface CardMeeting {
  id: string;
  title: string;
  description: string;
  startsAt: Date;
  durationMin: number;
  voiceChannelId: string;
  organizerId: string;
  status: MeetingStatus;
  autoRecord: boolean;
  agendaLocked: boolean;
}

export interface RenderedMessage {
  embeds: APIEmbed[];
  components: APIActionRowComponent<APIComponentInMessageActionRow>[];
}

const COLORS: Record<MeetingStatus, number> = {
  scheduled: 0x5865f2,
  live: 0x57f287,
  ended: 0x95a5a6,
  cancelled: 0xed4245,
};

// Budget de caractères par zone, pour rester sous les 6000 caractères par message.
const DESCRIPTION_BUDGET = 2000;
const RSVP_FIELD_BUDGET = 1000;
const AGENDA_BUDGET = 4000;
const AGENDA_DETAIL_PREVIEW = 300;

/** Carte de la réunion (premier message du post) : infos et présences, reconstruite depuis la BDD. */
export function renderMeetingCard(meeting: CardMeeting, rsvps: readonly Rsvp[], m: Messages): RenderedMessage {
  const groups = groupRsvps(rsvps);
  const mentions = (ids: string[]) =>
    ids.length === 0 ? m.card.nobody : joinLinesWithin(ids.map((id) => `<@${id}>`), RSVP_FIELD_BUDGET, m.card.more, ' ');

  const descriptionParts = [truncate(meeting.description, DESCRIPTION_BUDGET)];
  if (meeting.autoRecord && isOpen(meeting.status)) descriptionParts.push(m.card.autoRecord);
  const description = descriptionParts.filter(Boolean).join('\n\n');

  const embed = new EmbedBuilder()
    .setTitle(truncate(meeting.title, 256))
    .setColor(COLORS[meeting.status])
    .addFields(
      { name: m.card.when, value: `${discordTimestamp(meeting.startsAt, 'F')}\n${discordTimestamp(meeting.startsAt, 'R')}`, inline: true },
      { name: m.card.duration, value: m.card.minutes(meeting.durationMin), inline: true },
      { name: m.card.voice, value: `<#${meeting.voiceChannelId}>`, inline: true },
      { name: m.card.organizer, value: `<@${meeting.organizerId}>`, inline: true },
      { name: `✅ ${m.rsvp.yes} (${groups.yes.length})`, value: mentions(groups.yes), inline: false },
      { name: `❔ ${m.rsvp.maybe} (${groups.maybe.length})`, value: mentions(groups.maybe), inline: true },
      { name: `❌ ${m.rsvp.no} (${groups.no.length})`, value: mentions(groups.no), inline: true },
    )
    .setFooter({ text: m.card.footer(m.status[meeting.status]) })
    .setTimestamp(meeting.startsAt);
  if (description) embed.setDescription(description);

  const open = isOpen(meeting.status);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    rsvpButton(meeting.id, 'yes', `${m.rsvp.yes} (${groups.yes.length})`, ButtonStyle.Success, '✅', open),
    rsvpButton(meeting.id, 'maybe', `${m.rsvp.maybe} (${groups.maybe.length})`, ButtonStyle.Secondary, '❔', open),
    rsvpButton(meeting.id, 'no', `${m.rsvp.no} (${groups.no.length})`, ButtonStyle.Secondary, '❌', open),
    new ButtonBuilder()
      .setCustomId(encode({ type: 'meeting.edit', meetingId: meeting.id }))
      .setLabel(m.buttons.edit)
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!open),
  );

  return { embeds: [embed.toJSON()], components: [row.toJSON()] };
}

/** Second message du post : l'ordre du jour et ses boutons. */
export function renderAgendaMessage(
  meeting: Pick<CardMeeting, 'id' | 'status' | 'agendaLocked'>,
  agenda: readonly AgendaItem[],
  m: Messages,
): RenderedMessage {
  const open = isOpen(meeting.status);
  const embed = new EmbedBuilder()
    .setTitle(`📋 ${meeting.agendaLocked ? m.card.agendaLocked : m.card.agenda}`)
    .setColor(COLORS[meeting.status])
    .setDescription(renderAgenda(agenda, m));
  if (open && !meeting.agendaLocked) embed.setFooter({ text: m.card.agendaHint });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encode({ type: 'agenda.add', meetingId: meeting.id }))
      .setLabel(m.buttons.addItem)
      .setEmoji('➕')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!open || meeting.agendaLocked),
    new ButtonBuilder()
      .setCustomId(encode({ type: 'agenda.manage', meetingId: meeting.id }))
      .setLabel(m.buttons.manageAgenda)
      .setEmoji('🗂️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!open),
  );
  return { embeds: [embed.toJSON()], components: [row.toJSON()] };
}

function rsvpButton(meetingId: string, status: 'yes' | 'maybe' | 'no', label: string, style: ButtonStyle, emoji: string, enabled: boolean) {
  return new ButtonBuilder()
    .setCustomId(encode({ type: 'rsvp', meetingId, status }))
    .setLabel(label)
    .setEmoji(emoji)
    .setStyle(style)
    .setDisabled(!enabled);
}

export function renderAgenda(agenda: readonly AgendaItem[], m: Messages): string {
  if (agenda.length === 0) return m.card.agendaEmpty;
  const lines = agenda.map((item, i) => {
    const head = `**${i + 1}. ${truncate(item.title, 100)}** — ${m.card.agendaBy(item.authorId)}`;
    return item.detail ? `${head}\n> ${truncate(item.detail.replace(/\s*\n\s*/g, ' '), AGENDA_DETAIL_PREVIEW)}` : head;
  });
  return joinLinesWithin(lines, AGENDA_BUDGET, m.card.more, '\n\n');
}

/** Vue éphémère de gestion de l'ODJ (réservée aux gestionnaires). */
export function renderAgendaManager(
  meeting: { id: string; agendaLocked: boolean },
  agenda: readonly AgendaItem[],
  selectedId: number | null,
  m: Messages,
): { content: string; components: APIActionRowComponent<APIComponentInMessageActionRow>[] } {
  const rows: APIActionRowComponent<APIComponentInMessageActionRow>[] = [];
  const selectedIndex = selectedId === null ? -1 : agenda.findIndex((i) => i.id === selectedId);
  const selected = selectedIndex >= 0 ? agenda[selectedIndex] : undefined;

  if (agenda.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(encode({ type: 'agenda.select', meetingId: meeting.id }))
      .setPlaceholder(m.agendaManager.pick)
      .addOptions(
        agenda.map((item, i) => ({
          label: truncate(`${i + 1}. ${item.title}`, 100),
          value: String(item.id),
          ...(item.detail ? { description: truncate(item.detail, 100) } : {}),
          default: item.id === selected?.id,
        })),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON());
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>();
  if (selected) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(encode({ type: 'agenda.move', meetingId: meeting.id, itemId: selected.id, direction: 'up' }))
        .setLabel(m.buttons.moveUp)
        .setEmoji('⬆️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(selectedIndex === 0),
      new ButtonBuilder()
        .setCustomId(encode({ type: 'agenda.move', meetingId: meeting.id, itemId: selected.id, direction: 'down' }))
        .setLabel(m.buttons.moveDown)
        .setEmoji('⬇️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(selectedIndex === agenda.length - 1),
      new ButtonBuilder()
        .setCustomId(encode({ type: 'agenda.remove', meetingId: meeting.id, itemId: selected.id }))
        .setLabel(m.buttons.remove)
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger),
    );
  }
  buttons.addComponents(
    new ButtonBuilder()
      .setCustomId(encode({ type: 'agenda.lock', meetingId: meeting.id, locked: !meeting.agendaLocked }))
      .setLabel(meeting.agendaLocked ? m.buttons.unlock : m.buttons.lock)
      .setEmoji(meeting.agendaLocked ? '🔓' : '🔒')
      .setStyle(ButtonStyle.Secondary),
  );
  rows.push(buttons.toJSON());

  const content = [`**${m.agendaManager.title}**`, agenda.length === 0 ? m.agendaManager.empty : selected ? m.agendaManager.selected(selected.title) : '']
    .filter(Boolean)
    .join('\n');
  return { content, components: rows };
}
