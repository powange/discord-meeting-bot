import { describe, expect, it } from 'vitest';
import { renderPipelineStatus } from '../src/discord/embeds/pipelineStatus.js';
import { decode } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');
const id = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
const text = (c: unknown) => JSON.stringify(c);
const buttons = (c: { components: Array<{ type: number; components?: Array<{ custom_id?: string; label?: string }> }> }) =>
  c.components.filter((x) => x.type === 1).flatMap((r) => r.components ?? []);

describe('message de suivi du compte rendu', () => {
  it('en attente dans la file : il le dit', () => {
    const c = renderPipelineStatus(id, [{ step: 'mix', status: 'pending' }], m, undefined, null, true);
    expect(text(c)).toContain(m.pipeline.queued);
  });

  it('relance automatique programmée : « Réessayer la transcription maintenant »', () => {
    const c = renderPipelineStatus(id, [{ step: 'transcribe', status: 'pending' }], m, undefined, 'transcribe');
    const [b] = buttons(c as never);
    expect(decode(b!.custom_id!)?.type).toBe('report.retryNow');
    expect(b!.label).toBe(m.pipeline.retryNow('transcribe'));
  });

  it('échec : « Réessayer », cause lisible ; terminé : lien vers le compte rendu', () => {
    const failed = renderPipelineStatus(id, [{ step: 'mix', status: 'failed', detail: 'connect ECONNREFUSED' }], m);
    expect(buttons(failed as never).map((b) => b.label)).toEqual([m.pipeline.retry]);
    expect(text(failed)).toContain(m.pipeline.causes.unreachable);
    const done = renderPipelineStatus(id, [{ step: 'publish', status: 'done' }], m, 'https://discord.com/channels/1/2/3');
    expect(text(done)).toContain('(https://discord.com/channels/1/2/3)');
  });
});
