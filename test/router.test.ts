import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { routeInteraction } from '../src/discord/interactions/router.js';
import { encode } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';
import { fakeInteraction, spyObject } from './helpers/discordFakes.js';

const m = messages('fr');
const meetingId = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';

function context(over: Record<string, unknown> = {}) {
  return {
    log: pino({ level: 'silent' }),
    settings: { get: async () => ({ locale: 'fr', managerRoleIds: [] }), messages: async () => m },
    repos: spyObject({ getMeeting: async () => undefined }),
    ...over,
  };
}

describe('routeur des interactions', () => {
  it('erreur expliquée (réunion introuvable) : réponse éphémère avec le message', async () => {
    const { interaction, replies, lastText } = fakeInteraction({ kind: 'button', customId: encode({ type: 'meeting.end', meetingId }) });
    await routeInteraction(context() as never, interaction as never);
    expect(lastText()).toBe(`❌ ${m.errors.meetingNotFound}`);
    expect(replies.at(-1)?.how).toBe('reply');
  });

  it('erreur après un deferUpdate : message privé à part, le message d’origine n’est pas modifié', async () => {
    const { interaction, replies } = fakeInteraction({ kind: 'button', customId: encode({ type: 'meeting.end', meetingId }) });
    await interaction.deferUpdate();
    const { replyEphemeral } = await import('../src/discord/interactions/common.js');
    await replyEphemeral(interaction as never, 'Refusé.');
    expect(replies.map((r) => r.how)).toEqual(['followUp']);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('formulaire : acquitté avant tout accès à la base, puis réponse dans l’acquittement', async () => {
    const { interaction, replies, lastText } = fakeInteraction({ kind: 'modal', customId: encode({ type: 'meeting.editSubmit', meetingId }) });
    await routeInteraction(context() as never, interaction as never);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(replies.at(-1)?.how).toBe('editReply');
    expect(lastText()).toBe(`❌ ${m.errors.meetingNotFound}`);
  });

  it('erreur inattendue : message générique avec une référence, jamais le détail technique', async () => {
    const broken = context({ settings: { get: async () => Promise.reject(new Error('connexion perdue')), messages: async () => m } });
    const { interaction, lastText } = fakeInteraction({ kind: 'button', customId: encode({ type: 'meeting.end', meetingId }) });
    await routeInteraction(broken as never, interaction as never);
    expect(lastText()).toMatch(/Une erreur inattendue est survenue \(réf\. `[0-9a-f]{8}`\)/);
    expect(lastText()).not.toContain('connexion perdue');
  });

  it('identifiant inconnu (ancienne version) : ignoré sans réponse', async () => {
    const { interaction, replies } = fakeInteraction({ kind: 'button', customId: 'v0:inconnu' });
    await routeInteraction(context() as never, interaction as never);
    expect(replies).toEqual([]);
  });
});
