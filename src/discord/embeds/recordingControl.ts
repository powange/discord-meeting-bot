import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { encode } from '../../domain/customId.js';
import { currentPoint, nextPoint, type Marker } from '../../domain/markers.js';
import { isOpen } from '../../domain/meeting.js';
import { discordTimestamp } from '../../domain/time.js';
import type { MeetingStatus } from '../../domain/types.js';
import type { Messages } from '../../i18n/index.js';
import { truncate } from '../../lib/text.js';

export interface ControlMessage {
  content: string;
  components: Array<ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']> | ReturnType<ActionRowBuilder<StringSelectMenuBuilder>['toJSON']>>;
}

/** Ordre du jour et repères pris en direct (pendant l'enregistrement). */
export interface LiveState {
  agenda: ReadonlyArray<{ id: number; title: string }>;
  markers: readonly Marker[];
}

/** Valeur de l'option « hors ordre du jour » du sélecteur de point. */
export const OFF_AGENDA = 'off';

/**
 * Message de contrôle de l'enregistrement : état, bouton Enregistrer / Arrêter et, pendant
 * l'enregistrement, le point en cours avec « ▶️ Point suivant », « 📝 Note » et le choix direct d'un point.
 */
export function renderRecordingControl(meeting: { id: string; status: MeetingStatus }, recordingSince: Date | null, m: Messages, live?: LiveState): ControlMessage {
  if (!isOpen(meeting.status)) return { content: m.control.closed, components: [] };
  const button = recordingSince
    ? new ButtonBuilder()
        .setCustomId(encode({ type: 'rec.stop', meetingId: meeting.id }))
        .setLabel(m.buttons.stopRecording)
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger)
    : new ButtonBuilder()
        .setCustomId(encode({ type: 'rec.start', meetingId: meeting.id }))
        .setLabel(m.buttons.record)
        .setEmoji('🔴')
        .setStyle(ButtonStyle.Primary);
  if (!recordingSince) return { content: m.control.idle, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button).toJSON()] };

  const c = m.control;
  const agenda = live?.agenda ?? [];
  const markers = live?.markers ?? [];
  const lines = [c.recording(discordTimestamp(recordingSince, 't'))];
  const current = currentPoint(markers);
  if (agenda.length) {
    if (!current) lines.push(c.noPointYet);
    else if (current.agendaItemId === null) lines.push(c.offAgenda(discordTimestamp(current.since, 't')));
    else {
      const index = agenda.findIndex((a) => a.id === current.agendaItemId);
      if (index >= 0) lines.push(c.currentPoint(index + 1, truncate(agenda[index]!.title, 120), discordTimestamp(current.since, 't')));
    }
  }
  const notes = markers.filter((mk) => mk.kind !== 'agenda').length;
  if (notes) lines.push(c.notes(notes));

  const actions = new ActionRowBuilder<ButtonBuilder>();
  if (agenda.length) {
    const next = nextPoint(agenda, markers);
    const index = agenda.findIndex((a) => a.id === next);
    const label = index >= 0 ? `${index + 1}. ${agenda[index]!.title}` : c.endAgenda;
    // Rien après « fin de l'ordre du jour » quand on y est déjà.
    const done = next === null && current?.agendaItemId === null;
    actions.addComponents(
      new ButtonBuilder()
        .setCustomId(encode({ type: 'rec.next', meetingId: meeting.id }))
        .setLabel(truncate(c.next(label), 80))
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(done),
    );
  }
  actions.addComponents(new ButtonBuilder().setCustomId(encode({ type: 'rec.note', meetingId: meeting.id })).setLabel(c.note).setEmoji('📝').setStyle(ButtonStyle.Secondary));
  const rows: ControlMessage['components'] = [new ActionRowBuilder<ButtonBuilder>().addComponents(button).toJSON(), actions.toJSON()];
  if (agenda.length > 1) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(encode({ type: 'rec.goto', meetingId: meeting.id }))
      .setPlaceholder(c.goto)
      .addOptions(
        ...agenda.slice(0, 24).map((a, i) => ({ label: truncate(`${i + 1}. ${a.title}`, 100), value: String(a.id) })),
        { label: c.offAgendaOption, value: OFF_AGENDA, emoji: '💬' },
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON());
  }
  return { content: lines.join('\n'), components: rows };
}
