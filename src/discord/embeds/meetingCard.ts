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
import { bestSlot, respondents, type SlotTally } from '../../domain/datePoll.js';
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
  voiceChannelId: string | null;
  voiceDeletedAt?: Date | null;
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
  polling: 0xfee75c,
};

// Budget de caractères par zone, pour rester sous les 6000 caractères par message.
const DESCRIPTION_BUDGET = 2000;
const RSVP_FIELD_BUDGET = 1000;
const AGENDA_BUDGET = 4000;
const AGENDA_DETAIL_PREVIEW = 300;

/** Carte de la réunion (premier message du post) : infos et présences, reconstruite depuis la BDD. */
export function renderMeetingCard(
  meeting: CardMeeting,
  rsvps: readonly Rsvp[],
  m: Messages,
  /** Enregistrement en cours (début), ou null. */
  recordingSince: Date | null = null,
  /** Réunion terminée : liens vers le compte rendu et l'audio publiés. */
  links: { report: string | null; audio: string | null } = { report: null, audio: null },
  /** Sondage de date en cours : la grille remplace les inscriptions. */
  poll?: PollView,
): RenderedMessage {
  if (meeting.status === 'polling' && poll) return renderPollCard(meeting, poll, m);
  const groups = groupRsvps(rsvps);
  const mentions = (ids: string[]) =>
    ids.length === 0 ? m.card.nobody : joinLinesWithin(ids.map((id) => `<@${id}>`), RSVP_FIELD_BUDGET, m.card.more, ' ');

  const descriptionParts = [truncate(meeting.description, DESCRIPTION_BUDGET)];
  if (recordingSince) descriptionParts.push(m.card.recording(discordTimestamp(recordingSince, 't')));
  else if (meeting.autoRecord && isOpen(meeting.status)) descriptionParts.push(m.card.autoRecord);
  const description = descriptionParts.filter(Boolean).join('\n\n');

  const embed = new EmbedBuilder()
    .setTitle(truncate(meeting.title, 256))
    .setColor(COLORS[meeting.status])
    .addFields(
      { name: m.card.when, value: `${discordTimestamp(meeting.startsAt, 'F')}\n${discordTimestamp(meeting.startsAt, 'R')}`, inline: true },
      { name: m.card.duration, value: m.card.minutes(meeting.durationMin), inline: true },
      { name: m.card.voice, value: !meeting.voiceChannelId ? m.card.voicePending : meeting.voiceDeletedAt ? m.card.voiceDeleted : `<#${meeting.voiceChannelId}>`, inline: true },
      { name: m.card.organizer, value: `<@${meeting.organizerId}>`, inline: true },
      { name: `✅ ${m.rsvp.yes} (${groups.yes.length})`, value: mentions(groups.yes), inline: false },
      { name: `❔ ${m.rsvp.maybe} (${groups.maybe.length})`, value: mentions(groups.maybe), inline: true },
      { name: `❌ ${m.rsvp.no} (${groups.no.length})`, value: mentions(groups.no), inline: true },
    )
    .setFooter({ text: m.card.footer(m.status[meeting.status]) })
    .setTimestamp(meeting.startsAt);
  if (description) embed.setDescription(description);

  const open = isOpen(meeting.status);
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (open || (!links.report && !links.audio)) row.addComponents(...rsvpButtons(meeting.id, m, groups, open));
  else {
    // Réunion terminée : les réponses ne servent plus, le compte rendu et l'audio si.
    if (links.report) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.report).setLabel(m.card.reportLink).setEmoji('📝'));
    if (links.audio) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.audio).setLabel(m.card.audioLink).setEmoji('🎧'));
  }
  row.addComponents(
    // Panneau de gestion (organisateur et gestionnaires) : modifier, dupliquer, clore, annuler…
    new ButtonBuilder().setCustomId(encode({ type: 'meeting.manage', meetingId: meeting.id })).setLabel(m.buttons.manage).setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed.toJSON()], components: [row.toJSON()] };
}

export interface PollView {
  slots: ReadonlyArray<SlotTally & { label: string }>;
  closesAt: Date | null;
}

/** Budget de noms par créneau (l'embed est limité à 6 000 caractères au total). */
const SLOT_NAMES_BUDGET = 380;

/** Carte d'un sondage de date : une ligne par créneau (réponses et noms), meilleur créneau marqué ⭐. */
export function renderPollCard(meeting: CardMeeting, poll: PollView, m: Messages): RenderedMessage {
  const p = m.datePoll;
  const best = bestSlot(poll.slots);
  const people = respondents(poll.slots).size;
  const intro = [p.cardIntro(poll.closesAt ? discordTimestamp(poll.closesAt, 'f') : '—'), `-# ${p.legend}`, truncate(meeting.description, DESCRIPTION_BUDGET)];
  const embed = new EmbedBuilder()
    .setTitle(truncate(meeting.title, 256))
    .setColor(COLORS.polling)
    .setDescription(intro.filter(Boolean).join('\n\n'))
    .addFields(...pollFields(poll.slots, (s) => (best?.slotId === s.slotId ? '⭐ ' : ''), m), { name: m.card.organizer, value: `<@${meeting.organizerId}>`, inline: true })
    .setFooter({ text: `${m.card.footer(m.status.polling)} · ${people ? p.respondents(people) : p.noAnswers}` });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(encode({ type: 'poll.answer', meetingId: meeting.id })).setLabel(p.answerButton).setEmoji('🗳️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(encode({ type: 'meeting.manage', meetingId: meeting.id })).setLabel(m.buttons.manage).setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed.toJSON()], components: [row.toJSON()] };
}

/**
 * Résultat figé du sondage, publié dans le post quand la date est fixée : la carte redevient
 * une carte de réunion, ce message garde l'historique des réponses (créneau retenu marqué 📅).
 */
export function renderPollResults(title: string, slots: PollView['slots'], chosenSlotId: number, m: Messages): RenderedMessage {
  const p = m.datePoll;
  const people = respondents(slots).size;
  const embed = new EmbedBuilder()
    .setTitle(truncate(`🗳️ ${p.resultsTitle} · ${title}`, 256))
    .setColor(COLORS.polling)
    .setDescription(`-# ${p.legend}`)
    .addFields(...pollFields(slots, (s) => (s.slotId === chosenSlotId ? '📅 ' : ''), m, (s) => (s.slotId === chosenSlotId ? ` · **${p.chosen}**` : '')))
    .setFooter({ text: people ? p.respondents(people) : p.noAnswers });
  return { embeds: [embed.toJSON()], components: [] };
}

/** Une ligne par créneau : décompte puis noms (disponibles, si nécessaire, pas disponibles). */
function pollFields(
  slots: PollView['slots'],
  prefix: (s: SlotTally) => string,
  m: Messages,
  suffix: (s: SlotTally) => string = () => '',
): Array<{ name: string; value: string; inline: boolean }> {
  const names = (ids: string[]) => joinLinesWithin(ids.map((id) => `<@${id}>`), SLOT_NAMES_BUDGET / 3, m.card.more, ' ');
  return slots.slice(0, 20).map((s) => {
    const detail = [s.yes.length ? `✅ ${names(s.yes)}` : '', s.maybe.length ? `🟡 ${names(s.maybe)}` : '', s.no.length ? `❌ ${names(s.no)}` : '']
      .filter(Boolean)
      .join('\n');
    return {
      name: `${prefix(s)}${s.label}`,
      value: `✅ ${s.yes.length} · 🟡 ${s.maybe.length} · ❌ ${s.no.length}${suffix(s)}${detail ? `\n${detail}` : ''}`,
      inline: false,
    };
  });
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

/** Boutons de réponse (carte, rappels) : même customId partout. */
export function rsvpButtons(meetingId: string, m: Messages, counts?: Record<'yes' | 'maybe' | 'no', readonly unknown[]>, enabled = true): ButtonBuilder[] {
  const n = (k: 'yes' | 'maybe' | 'no') => (counts ? ` (${counts[k].length})` : '');
  return [
    rsvpButton(meetingId, 'yes', `${m.rsvp.yes}${n('yes')}`, ButtonStyle.Success, '✅', enabled),
    rsvpButton(meetingId, 'maybe', `${m.rsvp.maybe}${n('maybe')}`, ButtonStyle.Secondary, '❔', enabled),
    rsvpButton(meetingId, 'no', `${m.rsvp.no}${n('no')}`, ButtonStyle.Secondary, '❌', enabled),
  ];
}

function rsvpButton(meetingId: string, status: 'yes' | 'maybe' | 'no', label: string, style: ButtonStyle, emoji: string, enabled: boolean) {
  return new ButtonBuilder()
    .setCustomId(encode({ type: 'rsvp', meetingId, status }))
    .setLabel(label)
    .setEmoji(emoji)
    .setStyle(style)
    .setDisabled(!enabled);
}

/** Lignes du détail affichées au plus dans l'aperçu (la suite est dans « Gérer l'ordre du jour »). */
const AGENDA_DETAIL_LINES = 6;

/** Détail d'un point en citation, retours à la ligne conservés (lignes vides retirées), aperçu borné. */
function quoteDetail(detail: string): string {
  const lines = truncate(detail.trim(), AGENDA_DETAIL_PREVIEW)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const shown = lines.slice(0, AGENDA_DETAIL_LINES);
  if (lines.length > AGENDA_DETAIL_LINES) shown[AGENDA_DETAIL_LINES - 1] += ' …';
  return shown.map((line) => `> ${line}`).join('\n');
}

export function renderAgenda(agenda: readonly AgendaItem[], m: Messages): string {
  if (agenda.length === 0) return m.card.agendaEmpty;
  const lines = agenda.map((item, i) => {
    const head = `**${i + 1}. ${truncate(item.title, 100)}** — ${m.card.agendaBy(item.authorId)}`;
    return item.detail.trim() ? `${head}\n${quoteDetail(item.detail)}` : head;
  });
  return joinLinesWithin(lines, AGENDA_BUDGET, m.card.more, '\n\n');
}

/** Vue éphémère de gestion de l'ODJ (réservée aux gestionnaires). */
export function renderAgendaManager(
  meeting: { id: string; agendaLocked: boolean },
  agenda: readonly AgendaItem[],
  selectedId: number | null,
  m: Messages,
  /** « author » : un participant qui ne voit que ses propres points et ne peut que les modifier. */
  mode: 'manager' | 'author' = 'manager',
  /** Retrait du point sélectionné demandé : bouton de confirmation à la place des actions. */
  confirmRemove = false,
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
          ...(item.detail.trim() ? { description: truncate(item.detail.trim().replace(/\s*\n\s*/g, ' · '), 100) } : {}),
          default: item.id === selected?.id,
        })),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON());
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>();
  const editButton = (item: AgendaItem) =>
    new ButtonBuilder()
      .setCustomId(encode({ type: 'agenda.edit', meetingId: meeting.id, itemId: item.id }))
      .setLabel(m.buttons.editItem)
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary);
  if (mode === 'author') {
    if (selected) rows.push(buttons.addComponents(editButton(selected)).toJSON());
    const content = [`**${m.agendaManager.titleAuthor}**`, selected ? m.agendaManager.selected(selected.title) : m.agendaManager.pickOwn].join('\n');
    return { content, components: rows };
  }
  if (selected && confirmRemove) {
    rows.push(
      buttons
        .addComponents(
          new ButtonBuilder()
            .setCustomId(encode({ type: 'agenda.removeConfirm', meetingId: meeting.id, itemId: selected.id }))
            .setLabel(m.agendaManager.removeConfirm)
            .setEmoji('🗑️')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(encode({ type: 'agenda.manage', meetingId: meeting.id }))
            .setLabel(m.manage.back)
            .setEmoji('↩️')
            .setStyle(ButtonStyle.Secondary),
        )
        .toJSON(),
    );
    return { content: [`**${m.agendaManager.title}**`, m.agendaManager.removeAsk(selected.title)].join('\n'), components: rows };
  }
  if (selected) {
    buttons.addComponents(
      editButton(selected),
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
