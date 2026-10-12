import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { encode } from '../../domain/customId.js';
import { isOpen } from '../../domain/meeting.js';
import { discordTimestamp } from '../../domain/time.js';
import type { MeetingStatus } from '../../domain/types.js';
import type { Messages } from '../../i18n/index.js';

export interface ControlMessage {
  content: string;
  components: ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']>[];
}

/** Message de contrôle de l'enregistrement : état et bouton Enregistrer / Arrêter. */
export function renderRecordingControl(
  meeting: { id: string; status: MeetingStatus },
  recordingSince: Date | null,
  m: Messages,
): ControlMessage {
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
  return {
    content: recordingSince ? m.control.recording(discordTimestamp(recordingSince, 't')) : m.control.idle,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button).toJSON()],
  };
}
