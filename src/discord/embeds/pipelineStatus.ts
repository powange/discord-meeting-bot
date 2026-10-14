import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, type APIContainerComponent } from 'discord.js';
import { encode } from '../../domain/customId.js';
import { failureCause } from '../../domain/failure.js';
import type { PipelineStep, StepStatus } from '../../domain/types.js';
import type { Messages } from '../../i18n/index.js';
import { Accent } from '../ui/palette.js';

export interface StepView {
  step: PipelineStep;
  status: StepStatus;
  /** Progression (« 12/30 blocs ») ou erreur. */
  detail?: string | null;
  /** Étape volontairement sautée (ex. résumé sans LLM configuré). */
  skipped?: boolean;
}

/**
 * Message de suivi du traitement : une ligne par étape, bouton « Relancer » en cas d'échec,
 * « Réessayer … maintenant » pendant l'attente d'une relance automatique de l'étape `waiting`.
 */
export function renderPipelineStatus(meetingId: string, steps: readonly StepView[], m: Messages, publishedUrl?: string, waiting: PipelineStep | null = null): APIContainerComponent {
  const p = m.pipeline;
  const failed = steps.some((s) => s.status === 'failed');
  const allDone = steps.length > 0 && steps.every((s) => s.status === 'done');
  const lines = steps.map((s) => {
    // Message public : une cause compréhensible, jamais l'exception brute (elle va au salon d'alertes).
    const detail = s.status === 'failed' ? ` — ${p.causes[failureCause(s.detail ?? '')]}` : s.detail ? ` — ${s.detail}` : '';
    if (s.skipped) return `${p.skipped} ${p.steps[s.step] ?? s.step} — ${p.skippedDetail}`;
    return `${p[s.status]} ${p.steps[s.step] ?? s.step}${detail}`;
  });

  const container = new ContainerBuilder()
    .setAccentColor(failed ? Accent.danger : allDone ? Accent.live : Accent.pending)
    .addTextDisplayComponents((t) => t.setContent(`${p.title}\n${lines.join('\n')}`));
  if (allDone && publishedUrl) container.addTextDisplayComponents((t) => t.setContent(`-# ${p.published(publishedUrl)}`));
  if (failed) {
    container.addTextDisplayComponents((t) => t.setContent(`-# ${p.failedHint}`));
    container.addActionRowComponents((row: ActionRowBuilder<ButtonBuilder>) =>
      row.addComponents(new ButtonBuilder().setCustomId(encode({ type: 'report.retry', meetingId })).setLabel(p.retry).setEmoji('🔁').setStyle(ButtonStyle.Primary)),
    );
  } else if (waiting) {
    container.addActionRowComponents((row: ActionRowBuilder<ButtonBuilder>) =>
      row.addComponents(new ButtonBuilder().setCustomId(encode({ type: 'report.retryNow', meetingId })).setLabel(p.retryNow(waiting)).setEmoji('🔁').setStyle(ButtonStyle.Secondary)),
    );
  }
  return container.toJSON();
}
