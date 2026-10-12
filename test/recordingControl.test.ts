import type { APIButtonComponentWithCustomId } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { renderRecordingControl } from '../src/discord/embeds/recordingControl.js';
import { decode } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');
const id = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
const button = (c: ReturnType<typeof renderRecordingControl>) => c.components[0]?.components[0] as APIButtonComponentWithCustomId | undefined;

describe('renderRecordingControl', () => {
  it('réunion en cours, pas d’enregistrement : bouton Enregistrer', () => {
    const c = renderRecordingControl({ id, status: 'live' }, null, m);
    expect(c.content).toBe(m.control.idle);
    expect(decode(button(c)!.custom_id)).toEqual({ type: 'rec.start', meetingId: id });
  });
  it('enregistrement en cours : bouton Arrêter', () => {
    const c = renderRecordingControl({ id, status: 'live' }, new Date('2026-10-15T16:00:00Z'), m);
    expect(c.content).toContain('Enregistrement en cours');
    expect(decode(button(c)!.custom_id)).toEqual({ type: 'rec.stop', meetingId: id });
  });
  it('réunion close : plus de bouton', () => {
    const c = renderRecordingControl({ id, status: 'ended' }, null, m);
    expect(c.content).toBe(m.control.closed);
    expect(c.components).toEqual([]);
  });
});
