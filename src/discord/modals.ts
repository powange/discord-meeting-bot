import {
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from 'discord.js';
import { DateTime } from 'luxon';
import { AGENDA_DETAIL_MAX, AGENDA_TITLE_MAX } from '../domain/agenda.js';
import { DESCRIPTION_MAX, DURATION_MAX, DURATION_MIN, TITLE_MAX } from '../domain/meeting.js';
import { formatDateTimeInput, parseDateTime } from '../domain/time.js';
import type { Messages } from '../i18n/index.js';
import { UserError } from '../lib/errors.js';
import type { MeetingInput } from '../services/meetings.js';

const F = { title: 'title', when: 'when', duration: 'duration', voice: 'voice', description: 'description', detail: 'detail' } as const;

export interface MeetingModalOptions {
  customId: string;
  heading: string;
  /** Faux pour une réunion commencée : seuls le titre et la description restent modifiables. */
  reschedulable: boolean;
  timezone: string;
  defaults: Partial<MeetingInput>;
}

export function meetingModal(m: Messages, o: MeetingModalOptions): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(o.customId).setTitle(o.heading);
  const d = o.defaults;

  const title = new TextInputBuilder().setCustomId(F.title).setStyle(TextInputStyle.Short).setMaxLength(TITLE_MAX).setRequired(true);
  if (d.title) title.setValue(d.title);
  modal.addLabelComponents(new LabelBuilder().setLabel(m.modal.title).setTextInputComponent(title));

  if (o.reschedulable) {
    const when = new TextInputBuilder().setCustomId(F.when).setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true).setPlaceholder('15/10/2026 18:30');
    if (d.startsAt) when.setValue(formatDateTimeInput(d.startsAt, o.timezone));
    const duration = new TextInputBuilder().setCustomId(F.duration).setStyle(TextInputStyle.Short).setMaxLength(4).setRequired(true);
    if (d.durationMin) duration.setValue(String(d.durationMin));
    const voice = new ChannelSelectMenuBuilder().setCustomId(F.voice).setChannelTypes(ChannelType.GuildVoice).setRequired(true);
    if (d.voiceChannelId) voice.setDefaultChannels(d.voiceChannelId);
    modal.addLabelComponents(
      new LabelBuilder().setLabel(m.modal.when).setDescription(`${m.modal.whenHint} (${o.timezone})`).setTextInputComponent(when),
      new LabelBuilder().setLabel(m.modal.duration).setTextInputComponent(duration),
      new LabelBuilder().setLabel(m.modal.voice).setChannelSelectMenuComponent(voice),
    );
  }

  const description = new TextInputBuilder()
    .setCustomId(F.description)
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(DESCRIPTION_MAX)
    .setRequired(false)
    .setPlaceholder(m.modal.descriptionHint);
  if (d.description) description.setValue(d.description);
  modal.addLabelComponents(new LabelBuilder().setLabel(m.modal.description).setTextInputComponent(description));
  return modal;
}

/**
 * Lit et valide le formulaire de réunion. Pour une réunion non replanifiable, date, durée et
 * salon sont repris de `current`.
 */
export function readMeetingModal(
  interaction: ModalSubmitInteraction<'cached'>,
  m: Messages,
  options: { timezone: string; reschedulable: boolean; current?: MeetingInput; now?: DateTime },
): MeetingInput {
  const title = interaction.fields.getTextInputValue(F.title).trim();
  if (!title) throw new UserError(m.errors.titleRequired);
  const description = interaction.fields.getTextInputValue(F.description).trim();

  if (!options.reschedulable) {
    if (!options.current) throw new Error('Réunion actuelle requise pour une modification partielle');
    return { ...options.current, title, description };
  }

  const startsAt = parseWhen(interaction.fields.getTextInputValue(F.when), options.timezone, m, options.now ?? DateTime.now());
  const durationRaw = interaction.fields.getTextInputValue(F.duration).trim();
  const durationMin = /^\d+$/.test(durationRaw) ? Number(durationRaw) : NaN;
  if (!(durationMin >= DURATION_MIN && durationMin <= DURATION_MAX)) throw new UserError(m.errors.duration(DURATION_MIN, DURATION_MAX));

  const voice = interaction.fields.getSelectedChannels(F.voice, false, [ChannelType.GuildVoice])?.first();
  if (!voice) throw new UserError(m.errors.voiceRequired);
  if (voice.guildId !== interaction.guildId) throw new UserError(m.errors.voiceInvalid);

  // Une modification qui ne touche pas à la date ne doit pas échouer parce que la réunion approche.
  const unchanged = options.current && options.current.startsAt.getTime() === startsAt.getTime();
  if (!unchanged && startsAt.getTime() <= Date.now()) throw new UserError(m.errors.datePast);

  return { title, description, startsAt, durationMin, voiceChannelId: voice.id };
}

export function parseWhen(input: string, timezone: string, m: Messages, now: DateTime): Date {
  const parsed = parseDateTime(input, timezone, now);
  if (!parsed.ok) throw new UserError(parsed.error === 'format' ? m.errors.dateFormat : m.errors.dateInvalid);
  return parsed.value.toJSDate();
}

export function agendaItemModal(m: Messages, customId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(m.modal.agendaTitle)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(m.modal.itemTitle)
        .setTextInputComponent(new TextInputBuilder().setCustomId(F.title).setStyle(TextInputStyle.Short).setMaxLength(AGENDA_TITLE_MAX).setRequired(true)),
      new LabelBuilder()
        .setLabel(m.modal.itemDetail)
        .setDescription(m.modal.itemDetailHint)
        .setTextInputComponent(
          new TextInputBuilder().setCustomId(F.detail).setStyle(TextInputStyle.Paragraph).setMaxLength(AGENDA_DETAIL_MAX).setRequired(false),
        ),
    );
}

export function readAgendaItemModal(interaction: ModalSubmitInteraction): { title: string; detail: string } {
  return { title: interaction.fields.getTextInputValue(F.title), detail: interaction.fields.getTextInputValue(F.detail) };
}
