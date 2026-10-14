import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { encode } from '../../domain/customId.js';
import { currentPoint, nextPoint, type Marker } from '../../domain/markers.js';
import { discordTimestamp } from '../../domain/time.js';
import type { Messages } from '../../i18n/index.js';
import { truncate } from '../../lib/text.js';
import { consentButton } from './meetingManager.js';

export interface ControlMessage {
  content: string;
  components: Array<ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']> | ReturnType<ActionRowBuilder<StringSelectMenuBuilder>['toJSON']>>;
}

/** Ordre du jour et repères pris en direct (pendant l'enregistrement). */
export interface LiveState {
  agenda: ReadonlyArray<{ id: number; title: string }>;
  markers: readonly Marker[];
}

/**
 * État affiché par le message à boutons de l'enregistrement. Les boutons sont toujours sur le
 * dernier message : à chaque changement d'état, un nouveau message est publié en bas du post.
 */
export type ControlState =
  | { kind: 'idle' }
  | { kind: 'rec'; startedAt: Date; endedAt?: Date | null; startedBy: string | null; live?: LiveState }
  | { kind: 'stopped'; stoppedBy: string | null; reason: string; interrupted: boolean };

/** Valeur de l'option « hors ordre du jour » du sélecteur de point. */
export const OFF_AGENDA = 'off';

/** Raisons d'arrêt qui sont des interruptions (une reprise est attendue). */
export const INTERRUPTIONS: readonly string[] = ['shutdown', 'disconnected', 'crash'];

const recordButton = (meetingId: string, label: string) =>
  new ButtonBuilder().setCustomId(encode({ type: 'rec.start', meetingId })).setLabel(label).setEmoji('🔴').setStyle(ButtonStyle.Primary);

/**
 * Message à boutons de l'enregistrement. `frozen` : version d'un message dépassé (un état plus
 * récent est affiché plus bas), sans boutons.
 */
export function renderRecordingControl(meetingId: string, state: ControlState, m: Messages, frozen = false): ControlMessage {
  const c = m.control;
  if (state.kind === 'idle') {
    return { content: c.idle, components: frozen ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(recordButton(meetingId, m.buttons.record)).toJSON()] };
  }

  if (state.kind === 'stopped') {
    const content = state.interrupted ? m.recording.interruptedShort(state.reason) : m.recording.stopped(state.stoppedBy, state.reason);
    return { content, components: frozen ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(recordButton(meetingId, m.buttons.resumeRecording)).toJSON()] };
  }

  if (frozen) {
    return { content: c.recorded(state.startedBy, discordTimestamp(state.startedAt, 't'), state.endedAt ? discordTimestamp(state.endedAt, 't') : null), components: [] };
  }

  // En cours : avertissement, point en cours, notes ; puis Arrêter, Point suivant, Note, choix direct.
  const agenda = state.live?.agenda ?? [];
  const markers = state.live?.markers ?? [];
  const [head, ...rest] = m.recording.announce(state.startedBy).split('\n');
  const optOut = rest.pop()!;
  const lines = [head!, ...rest];
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
  lines.push(optOut);

  const stop = new ButtonBuilder().setCustomId(encode({ type: 'rec.stop', meetingId })).setLabel(m.buttons.stopRecording).setEmoji('⏹️').setStyle(ButtonStyle.Danger);
  const actions = new ActionRowBuilder<ButtonBuilder>();
  if (agenda.length) {
    const next = nextPoint(agenda, markers);
    const index = agenda.findIndex((a) => a.id === next);
    const label = index >= 0 ? `${index + 1}. ${agenda[index]!.title}` : c.endAgenda;
    // Rien après « fin de l'ordre du jour » quand on y est déjà.
    const done = next === null && current?.agendaItemId === null;
    actions.addComponents(
      new ButtonBuilder()
        .setCustomId(encode({ type: 'rec.next', meetingId }))
        .setLabel(truncate(c.next(label), 80))
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(done),
    );
  }
  actions.addComponents(new ButtonBuilder().setCustomId(encode({ type: 'rec.note', meetingId })).setLabel(c.note).setEmoji('📝').setStyle(ButtonStyle.Secondary));
  const rows: ControlMessage['components'] = [actions.toJSON()];
  if (agenda.length > 1) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(encode({ type: 'rec.goto', meetingId }))
      .setPlaceholder(c.goto)
      .addOptions(
        ...agenda.slice(0, 24).map((a, i) => ({ label: truncate(`${i + 1}. ${a.title}`, 100), value: String(a.id) })),
        { label: c.offAgendaOption, value: OFF_AGENDA, emoji: '💬' },
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON());
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(stop, consentButton(m)).toJSON());
  return { content: lines.join('\n'), components: rows };
}
