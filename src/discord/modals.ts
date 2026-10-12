import {
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from 'discord.js';
import { DateTime } from 'luxon';
import { AGENDA_DETAIL_MAX, AGENDA_TITLE_MAX } from '../domain/agenda.js';
import { DESCRIPTION_MAX, DURATION_MAX, DURATION_MIN, TITLE_MAX } from '../domain/meeting.js';
import { combineDayTime, dayChoices, dayOf, formatTimeRange, OTHER_DAY, parseDatedRange, parseDateTime, parseTimeRange } from '../domain/time.js';
import type { Messages } from '../i18n/index.js';
import { UserError } from '../lib/errors.js';
import type { MeetingInput } from '../services/meetings.js';

const F = { title: 'title', day: 'day', time: 'time', voice: 'voice', description: 'description', detail: 'detail' } as const;

/** Nombre de jours proposés (limite Discord d'un menu déroulant). */
const DAY_CHOICES = 25;

export interface MeetingModalOptions {
  customId: string;
  heading: string;
  /** Faux pour une réunion commencée : seuls le titre et la description restent modifiables. */
  reschedulable: boolean;
  timezone: string;
  locale: string;
  defaultDurationMin: number;
  /** Salon vocal imposé par la configuration : le choix du salon n'est alors pas proposé. */
  fixedVoiceChannelId: string | null;
  now?: Date;
  defaults: Partial<MeetingInput>;
}

export function meetingModal(m: Messages, o: MeetingModalOptions): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(o.customId).setTitle(o.heading);
  const d = o.defaults;

  const title = new TextInputBuilder().setCustomId(F.title).setStyle(TextInputStyle.Short).setMaxLength(TITLE_MAX).setRequired(true);
  if (d.title) title.setValue(d.title);
  modal.addLabelComponents(new LabelBuilder().setLabel(m.modal.title).setTextInputComponent(title));

  if (o.reschedulable) {
    const now = o.now ?? new Date();
    const selectedDay = d.startsAt ? dayOf(d.startsAt, o.timezone) : undefined;
    const today = dayOf(now, o.timezone);
    const day = new StringSelectMenuBuilder()
      .setCustomId(F.day)
      .setPlaceholder(m.modal.dayPlaceholder)
      .setRequired(true)
      .addOptions(
        ...dayChoices(o.timezone, now, DAY_CHOICES - 1, selectedDay).map((iso) => ({
          label: dayLabel(iso, today, o.timezone, o.locale, m),
          value: iso,
          default: iso === selectedDay,
        })),
        // Au-delà des prochains jours : la date se saisit avec l'horaire.
        { label: m.modal.otherDay, value: OTHER_DAY, emoji: '📅', description: m.modal.otherDayHint },
      );

    const time = new TextInputBuilder()
      .setCustomId(F.time)
      .setStyle(TextInputStyle.Short)
      .setMaxLength(30)
      .setRequired(true)
      .setPlaceholder(m.modal.timePlaceholder);
    if (d.startsAt) time.setValue(formatTimeRange(d.startsAt, d.durationMin ?? o.defaultDurationMin, o.timezone));

    modal.addLabelComponents(
      new LabelBuilder().setLabel(m.modal.day).setStringSelectMenuComponent(day),
      new LabelBuilder()
        .setLabel(m.modal.time)
        .setDescription(m.modal.timeHint(m.card.minutes(d.durationMin ?? o.defaultDurationMin), o.timezone))
        .setTextInputComponent(time),
    );
    if (!o.fixedVoiceChannelId) {
      const voice = new ChannelSelectMenuBuilder().setCustomId(F.voice).setChannelTypes(ChannelType.GuildVoice).setRequired(true);
      if (d.voiceChannelId) voice.setDefaultChannels(d.voiceChannelId);
      modal.addLabelComponents(new LabelBuilder().setLabel(m.modal.voice).setChannelSelectMenuComponent(voice));
    }
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

/** « lundi 12/10 (aujourd'hui) » */
function dayLabel(iso: string, today: string, zone: string, locale: string, m: Messages): string {
  const date = DateTime.fromISO(iso, { zone }).setLocale(locale);
  const label = date.toFormat('cccc dd/MM');
  const diff = Math.round(date.diff(DateTime.fromISO(today, { zone }), 'days').days);
  if (diff === 0) return `${label} (${m.modal.today})`;
  if (diff === 1) return `${label} (${m.modal.tomorrow})`;
  return date.year === DateTime.fromISO(today, { zone }).year ? label : date.toFormat('cccc dd/MM/yyyy');
}

/**
 * Lit et valide le formulaire de réunion. Pour une réunion non replanifiable, date, durée et
 * salon sont repris de `current`.
 */
export function readMeetingModal(
  interaction: ModalSubmitInteraction<'cached'>,
  m: Messages,
  options: {
    timezone: string;
    reschedulable: boolean;
    defaultDurationMin: number;
    fixedVoiceChannelId: string | null;
    current?: MeetingInput;
  },
): MeetingInput {
  const title = interaction.fields.getTextInputValue(F.title).trim();
  if (!title) throw new UserError(m.errors.titleRequired);
  const description = interaction.fields.getTextInputValue(F.description).trim();

  if (!options.reschedulable) {
    if (!options.current) throw new Error('Réunion actuelle requise pour une modification partielle');
    return { ...options.current, title, description };
  }

  let day = interaction.fields.getStringSelectValues(F.day)[0];
  if (!day) throw new UserError(m.errors.dayRequired);
  const timeInput = interaction.fields.getTextInputValue(F.time);
  let range: { hour: number; minute: number; durationMin: number | null };
  if (day === OTHER_DAY) {
    const dated = parseDatedRange(timeInput, options.timezone, DateTime.now());
    if (!dated.ok) throw new UserError(dated.error === 'format' ? m.errors.otherDayFormat : m.errors.dateInvalid);
    day = dated.day;
    range = dated;
  } else {
    const parsed = parseTimeRange(timeInput);
    if (!parsed.ok) throw new UserError(m.errors.timeFormat);
    range = parsed;
  }
  const startsAt = combineDayTime(day, range.hour, range.minute, options.timezone);
  if (!startsAt) throw new UserError(m.errors.dateInvalid);
  const durationMin = range.durationMin ?? options.current?.durationMin ?? options.defaultDurationMin;
  if (!(durationMin >= DURATION_MIN && durationMin <= DURATION_MAX)) throw new UserError(m.errors.duration(DURATION_MIN, DURATION_MAX));

  let voiceChannelId = options.fixedVoiceChannelId;
  if (!voiceChannelId) {
    const voice = interaction.fields.getSelectedChannels(F.voice, false, [ChannelType.GuildVoice])?.first();
    if (!voice) throw new UserError(m.errors.voiceRequired);
    if (voice.guildId !== interaction.guildId) throw new UserError(m.errors.voiceInvalid);
    voiceChannelId = voice.id;
  }

  // Une modification qui ne touche pas à la date ne doit pas échouer parce que la réunion approche.
  const unchanged = options.current && options.current.startsAt.getTime() === startsAt.getTime();
  if (!unchanged && startsAt.getTime() <= Date.now()) throw new UserError(m.errors.datePast);

  return { title, description, startsAt, durationMin, voiceChannelId };
}

export function parseWhen(input: string, timezone: string, m: Messages, now: DateTime): Date {
  const parsed = parseDateTime(input, timezone, now);
  if (!parsed.ok) throw new UserError(parsed.error === 'format' ? m.errors.dateFormat : m.errors.dateInvalid);
  return parsed.value.toJSDate();
}

export function agendaItemModal(m: Messages, customId: string, current?: { title: string; detail: string }): ModalBuilder {
  const title = new TextInputBuilder().setCustomId(F.title).setStyle(TextInputStyle.Short).setMaxLength(AGENDA_TITLE_MAX).setRequired(true);
  const detail = new TextInputBuilder().setCustomId(F.detail).setStyle(TextInputStyle.Paragraph).setMaxLength(AGENDA_DETAIL_MAX).setRequired(false);
  if (current) {
    title.setValue(current.title);
    if (current.detail) detail.setValue(current.detail);
  }
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(current ? m.modal.agendaEditTitle : m.modal.agendaTitle)
    .addLabelComponents(
      new LabelBuilder().setLabel(m.modal.itemTitle).setTextInputComponent(title),
      new LabelBuilder().setLabel(m.modal.itemDetail).setDescription(m.modal.itemDetailHint).setTextInputComponent(detail),
    );
}

export function readAgendaItemModal(interaction: ModalSubmitInteraction): { title: string; detail: string } {
  return { title: interaction.fields.getTextInputValue(F.title), detail: interaction.fields.getTextInputValue(F.detail) };
}
