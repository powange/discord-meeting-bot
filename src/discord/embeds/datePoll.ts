import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, StringSelectMenuBuilder, type APIContainerComponent } from 'discord.js';
import type { Availability } from '../../domain/datePoll.js';
import { encode } from '../../domain/customId.js';
import type { Messages } from '../../i18n/index.js';
import { truncate } from '../../lib/text.js';
import { Accent } from '../ui/palette.js';

const EMOJI: Record<Availability, string> = { yes: '✅', maybe: '🟡', no: '❌' };
const ORDER: readonly Availability[] = ['yes', 'maybe', 'no'];

export interface PanelSlot {
  id: number;
  label: string;
  /** Réponse actuelle de la personne, ou null si elle n'a pas encore répondu. */
  answer: Availability | null;
}

/**
 * Panneau personnel (éphémère) : un menu par créneau, présélectionné sur la réponse actuelle.
 * Chaque option reprend le créneau dans son libellé (le menu affiche l'option choisie, pas son
 * texte d'invite). 2 composants par créneau : 10 créneaux tiennent dans la limite de 40.
 */
export function renderPollPanel(meeting: { id: string; title: string }, slots: readonly PanelSlot[], m: Messages, notice?: string): APIContainerComponent {
  const p = m.datePoll;
  const container = new ContainerBuilder()
    .setAccentColor(Accent.pending)
    .addTextDisplayComponents((t) => t.setContent(`## 🗳️ ${p.panelTitle}\n-# ${truncate(meeting.title, 120)} · ${p.panelHint}${notice ? `\n\n${notice}` : ''}`));
  for (const slot of slots) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(encode({ type: 'poll.vote', meetingId: meeting.id, slotId: slot.id }))
      .setPlaceholder(truncate(`${slot.label} · ${p.notAnswered}`, 150))
      .addOptions(
        ORDER.map((answer) => ({
          label: truncate(`${slot.label} · ${p.answers[answer]}`, 100),
          value: answer,
          emoji: EMOJI[answer],
          default: slot.answer === answer,
        })),
      );
    container.addActionRowComponents((row: ActionRowBuilder<StringSelectMenuBuilder>) => row.addComponents(select));
  }
  return container.toJSON();
}

export interface RankedSlot {
  id: number;
  label: string;
  yes: number;
  maybe: number;
  no: number;
}

/** Choix d'un créneau par l'organisateur : fixer la date, ou retirer un créneau. */
export function renderSlotChoice(
  meeting: { id: string; title: string },
  slots: readonly RankedSlot[],
  purpose: 'fix' | 'remove' | 'reslot',
  m: Messages,
): APIContainerComponent {
  const p = m.datePoll;
  const type = purpose === 'fix' ? 'poll.fixSelect' : purpose === 'remove' ? 'poll.removeSelect' : 'meeting.reslotSelect';
  const select = new StringSelectMenuBuilder()
    .setCustomId(encode({ type, meetingId: meeting.id }))
    .setPlaceholder(purpose === 'remove' ? p.pickRemove : p.pickFix)
    .addOptions(
      slots.slice(0, 25).map((s) => ({
        label: truncate(s.label, 100),
        value: String(s.id),
        description: `✅ ${s.yes} · 🟡 ${s.maybe} · ❌ ${s.no}`,
      })),
    );
  return new ContainerBuilder()
    .setAccentColor(Accent.pending)
    .addTextDisplayComponents((t) =>
      t.setContent(
        `## ${purpose === 'fix' ? `📅 ${p.fixDate}` : purpose === 'remove' ? `➖ ${p.removeSlot}` : `🗳️ ${p.reslot}`}\n-# ${truncate(meeting.title, 120)}${purpose === 'reslot' ? `\n${p.reslotHint}` : ''}`,
      ),
    )
    .addActionRowComponents((row: ActionRowBuilder<StringSelectMenuBuilder>) => row.addComponents(select))
    .addActionRowComponents((row: ActionRowBuilder<ButtonBuilder>) =>
      row.addComponents(new ButtonBuilder().setCustomId(encode({ type: 'meeting.manage', meetingId: meeting.id })).setLabel(m.manage.back).setEmoji('↩️').setStyle(ButtonStyle.Secondary)),
    )
    .toJSON();
}
