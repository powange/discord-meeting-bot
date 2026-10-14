import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, type APIEmbed } from 'discord.js';
import { encode } from '../../domain/customId.js';
import { currentPoint, nextPoint, type Marker } from '../../domain/markers.js';
import { discordTimestamp } from '../../domain/time.js';
import type { Messages } from '../../i18n/index.js';
import { truncate } from '../../lib/text.js';
import { consentButton } from './meetingManager.js';
import { Accent } from '../ui/palette.js';

/** Message en embed (comme la carte et l'ordre du jour) ; le texte brut est vidé à l'édition. */
export interface ControlMessage {
  embeds: APIEmbed[];
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
  | { kind: 'rec'; startedAt: Date; endedAt?: Date | null; startedBy: string | null }
  | { kind: 'stopped'; stoppedBy: string | null; reason: string; interrupted: boolean };

/** Valeur de l'option « hors ordre du jour » du sélecteur de point. */
export const OFF_AGENDA = 'off';

/** Raisons d'arrêt qui sont des interruptions (une reprise est attendue). */
export const INTERRUPTIONS: readonly string[] = ['shutdown', 'disconnected', 'crash'];

/** Couleurs : en cours (rouge), suivi (bleu), arrêté (vert), interrompu (orange), passé (gris). */
const COLORS = { rec: Accent.danger, live: Accent.brand, stopped: Accent.brand, interrupted: Accent.warning, past: Accent.muted } as const;
const embed = (title: string, description: string, color: number, footer?: string) => {
  const e = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
  if (footer) e.setFooter({ text: footer });
  return e.toJSON();
};

const recordButton = (meetingId: string, label: string) =>
  new ButtonBuilder().setCustomId(encode({ type: 'rec.start', meetingId })).setLabel(label).setEmoji('🔴').setStyle(ButtonStyle.Primary);

/**
 * Message à boutons de l'enregistrement. `frozen` : version d'un message dépassé (un état plus
 * récent est affiché plus bas), sans boutons.
 */
export function renderRecordingControl(meetingId: string, state: ControlState, m: Messages, frozen = false): ControlMessage {
  const e = m.control.embed;
  if (state.kind === 'idle') {
    return {
      embeds: [embed(e.idleTitle, e.idle, COLORS.past)],
      components: frozen ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(recordButton(meetingId, m.buttons.record)).toJSON()],
    };
  }

  if (state.kind === 'stopped') {
    const shown = state.interrupted
      ? embed(e.interruptedTitle, e.interrupted(state.reason), frozen ? COLORS.past : COLORS.interrupted, frozen ? undefined : e.resumeHint)
      : embed(e.stoppedTitle, e.stopped(state.stoppedBy, state.reason), frozen ? COLORS.past : COLORS.stopped, frozen ? undefined : e.resumeHint);
    return { embeds: [shown], components: frozen ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(recordButton(meetingId, m.buttons.resumeRecording)).toJSON()] };
  }

  if (frozen) {
    const to = state.endedAt ? discordTimestamp(state.endedAt, 't') : null;
    return { embeds: [embed(e.recordedTitle, e.recorded(state.startedBy, discordTimestamp(state.startedAt, 't'), to), COLORS.past)], components: [] };
  }

  // En cours : l'avertissement, avec Arrêter et « Mon choix d'enregistrement ». Le suivi de l'ordre
  // du jour est dans un message à part, juste en dessous (renderLiveControl).
  const stop = new ButtonBuilder().setCustomId(encode({ type: 'rec.stop', meetingId })).setLabel(m.buttons.stopRecording).setEmoji('⏹️').setStyle(ButtonStyle.Danger);
  return {
    embeds: [embed(e.recTitle, e.rec(state.startedBy, discordTimestamp(state.startedAt, 't')), COLORS.rec, e.recFooter)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(stop, consentButton(m)).toJSON()],
  };
}

/**
 * Suivi de l'ordre du jour pendant l'enregistrement (message sous l'avertissement) : point en
 * cours et notes, avec ▶️ Point suivant, 📝 Note et le choix direct d'un point. `frozen` : après
 * l'arrêt, sans boutons.
 */
export function renderLiveControl(meetingId: string, live: LiveState, m: Messages, frozen = false): ControlMessage {
  const c = m.control;
  const { agenda, markers } = live;
  const lines: string[] = [];
  const current = currentPoint(markers);
  if (agenda.length) {
    if (!current) lines.push(frozen ? c.noPointSet : c.noPointYet);
    else if (current.agendaItemId === null) lines.push(c.offAgenda(discordTimestamp(current.since, 't')));
    else {
      const index = agenda.findIndex((a) => a.id === current.agendaItemId);
      if (index >= 0) lines.push((frozen ? c.lastPoint : c.currentPoint)(index + 1, truncate(agenda[index]!.title, 120), discordTimestamp(current.since, 't')));
    }
  } else if (!frozen) {
    lines.push(c.noAgenda);
  }
  const notes = markers.filter((mk) => mk.kind !== 'agenda').length;
  if (notes) lines.push(c.notes(notes));
  const shown = embed(c.liveTitle, lines.join('\n') || c.noPointSet, frozen ? COLORS.past : COLORS.live, frozen ? undefined : c.embed.liveFooter);
  if (frozen) return { embeds: [shown], components: [] };

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
        .setLabel(truncate(current ? c.next(label) : c.start(label), 80))
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
  return { embeds: [shown], components: rows };
}
