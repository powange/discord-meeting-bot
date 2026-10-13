import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, type APIContainerComponent } from 'discord.js';
import { encode, type Action } from '../../domain/customId.js';
import { isOpen } from '../../domain/meeting.js';
import type { MeetingStatus } from '../../domain/types.js';
import type { Messages } from '../../i18n/index.js';

export interface ManagerState {
  /** Une session d'enregistrement existe : le compte rendu peut être régénéré. */
  hasRecording: boolean;
  /** Clôture demandée : bouton de confirmation. */
  confirmEnd?: boolean;
  /** « Tout retranscrire » demandé : bouton de confirmation (long, occupe le serveur de transcription). */
  confirmRegenAll?: boolean;
  /** Enregistrement en cours : bouton Arrêter au lieu d'Enregistrer. */
  recording?: boolean;
  notice?: string | undefined;
}

type MeetingAction = Extract<Action, { meetingId: string }>['type'];

/** Panneau « Gérer » d'une réunion (organisateur et gestionnaires) : remplace les sous-commandes /reunion. */
export function renderMeetingManager(
  meeting: { id: string; title: string; status: MeetingStatus; autoRecord: boolean },
  state: ManagerState,
  m: Messages,
): APIContainerComponent {
  const g = m.manage;
  const open = isOpen(meeting.status);
  const button = (type: MeetingAction, label: string, emoji: string, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(encode({ type, meetingId: meeting.id } as Action)).setLabel(label).setEmoji(emoji).setStyle(style);

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents((t) =>
      t.setContent(`## ⚙️ ${g.title}\n-# ${meeting.title} · ${m.status[meeting.status]}${state.notice ? `\n\n${state.notice}` : ''}`),
    );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  // Sondage de date : modifier le texte, fixer la date, gérer les créneaux, annuler.
  if (meeting.status === 'polling') {
    const p = m.datePoll;
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button('poll.fix', p.fixDate, '📅', ButtonStyle.Primary),
        button('poll.add', p.addSlot, '➕'),
        button('poll.remove', p.removeSlot, '➖'),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(button('meeting.edit', g.edit, '✏️'), button('meeting.cancel', g.cancel, '❌', ButtonStyle.Danger)),
    );
    for (const row of rows) container.addActionRowComponents(row);
    return container.toJSON();
  }
  const main = new ActionRowBuilder<ButtonBuilder>();
  if (open) main.addComponents(button('meeting.edit', g.edit, '✏️', ButtonStyle.Primary));
  main.addComponents(button('meeting.duplicate', g.duplicate, '📄'));
  if (open) main.addComponents(button('meeting.autoRecord', meeting.autoRecord ? g.autoOff : g.autoOn, meeting.autoRecord ? '⏸️' : '🔴'));
  rows.push(main);
  // Enregistrer à tout moment, même avant l'heure ou avant que quelqu'un rejoigne le vocal.
  if (open) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        state.recording ? button('rec.stop', g.recStop, '⏹️', ButtonStyle.Danger) : button('rec.start', g.recStart, '🔴', ButtonStyle.Success),
      ),
    );
  }

  if (open) {
    rows.push(
      state.confirmEnd
        ? new ActionRowBuilder<ButtonBuilder>().addComponents(
            button('meeting.endConfirm', g.endConfirm, '⏹️', ButtonStyle.Danger),
            button('meeting.manage', g.back, '↩️'),
          )
        : new ActionRowBuilder<ButtonBuilder>().addComponents(button('meeting.end', g.end, '⏹️'), button('meeting.cancel', g.cancel, '❌', ButtonStyle.Danger)),
    );
  }
  if (state.hasRecording) {
    rows.push(
      state.confirmRegenAll
        ? new ActionRowBuilder<ButtonBuilder>().addComponents(
            button('meeting.regenAllConfirm', g.regenAllConfirm, '🔁', ButtonStyle.Danger),
            button('meeting.manage', g.back, '↩️'),
          )
        : new ActionRowBuilder<ButtonBuilder>().addComponents(button('meeting.regen', g.regen, '📝'), button('meeting.regenAll', g.regenAll, '🔁')),
    );
  }
  for (const row of rows) container.addActionRowComponents(row);
  return container.toJSON();
}

/** Choix personnel d'enregistrement (message éphémère). */
export function renderConsent(state: { refused: boolean; notice?: string | undefined }, m: Messages): APIContainerComponent {
  const c = m.consent;
  const container = new ContainerBuilder().setAccentColor(state.refused ? 0x95a5a6 : 0xed4245);
  container.addTextDisplayComponents((t) =>
    t.setContent(`## 🎙️ ${c.title}\n${state.refused ? c.statusRefused : c.statusAccepted}\n-# ${c.explain}${state.notice ? `\n\n${state.notice}` : ''}`),
  );
  container.addActionRowComponents((row: ActionRowBuilder<ButtonBuilder>) =>
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(encode({ type: 'consent.refuse' }))
        .setLabel(c.refuse)
        .setEmoji('🔇')
        .setStyle(state.refused ? ButtonStyle.Secondary : ButtonStyle.Danger)
        .setDisabled(state.refused),
      new ButtonBuilder()
        .setCustomId(encode({ type: 'consent.accept' }))
        .setLabel(c.accept)
        .setEmoji('🎙️')
        .setStyle(state.refused ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(!state.refused),
    ),
  );
  return container.toJSON();
}

/** Bouton d'accès au choix d'enregistrement (post épinglé, avertissements). */
export function consentButton(m: Messages): ButtonBuilder {
  return new ButtonBuilder().setCustomId(encode({ type: 'consent.open' })).setLabel(m.consent.open).setEmoji('🎙️').setStyle(ButtonStyle.Secondary);
}
