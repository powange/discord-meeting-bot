import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, type APIContainerComponent } from 'discord.js';
import { encode } from '../../domain/customId.js';
import type { PipelineStep, StepStatus } from '../../domain/types.js';
import type { Messages } from '../../i18n/index.js';
import { truncate } from '../../lib/text.js';

export interface StepView {
  step: PipelineStep;
  status: StepStatus;
  /** Progression (« 12/30 blocs ») ou erreur. */
  detail?: string | null;
}

/** Message de suivi du traitement : une ligne par étape, bouton « Relancer » en cas d'échec. */
export function renderPipelineStatus(meetingId: string, steps: readonly StepView[], m: Messages, publishedUrl?: string): APIContainerComponent {
  const p = m.pipeline;
  const failed = steps.some((s) => s.status === 'failed');
  const allDone = steps.length > 0 && steps.every((s) => s.status === 'done');
  const lines = steps.map((s) => {
    const detail = s.detail ? ` — ${s.status === 'failed' ? truncate(s.detail, 300) : s.detail}` : '';
    return `${p[s.status]} ${p.steps[s.step] ?? s.step}${detail}`;
  });

  const container = new ContainerBuilder()
    .setAccentColor(failed ? 0xed4245 : allDone ? 0x57f287 : 0xfee75c)
    .addTextDisplayComponents((t) => t.setContent(`${p.title}\n${lines.join('\n')}`));
  if (allDone && publishedUrl) container.addTextDisplayComponents((t) => t.setContent(`-# ${p.published(publishedUrl)}`));
  if (failed) {
    container.addTextDisplayComponents((t) => t.setContent(`-# ${p.failedHint}`));
    container.addActionRowComponents((row: ActionRowBuilder<ButtonBuilder>) =>
      row.addComponents(new ButtonBuilder().setCustomId(encode({ type: 'report.retry', meetingId })).setLabel(p.retry).setEmoji('🔁').setStyle(ButtonStyle.Primary)),
    );
  }
  return container.toJSON();
}
