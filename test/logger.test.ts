import { describe, expect, it } from 'vitest';
import { safeErrorSerializer } from '../src/lib/logger.js';

describe('journaux', () => {
  it('une erreur Discord est journalisée sans le contenu envoyé', () => {
    const err = Object.assign(new Error('Missing Permissions'), { code: 50013, requestBody: { json: { content: 'Compte rendu confidentiel' } }, rawError: { message: 'x' } });
    const out = safeErrorSerializer(err) as Record<string, unknown>;
    expect(out).toMatchObject({ message: 'Missing Permissions', code: 50013 });
    expect(JSON.stringify(out)).not.toContain('confidentiel');
    expect(out).not.toHaveProperty('rawError');
  });
});
