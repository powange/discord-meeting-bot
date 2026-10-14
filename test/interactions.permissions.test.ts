import { PermissionFlagsBits } from 'discord.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import type { GuildSettingsRow, MeetingRow } from '../src/db/schema.js';
import { handleAction } from '../src/discord/interactions/components.js';
import type { Action } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';
import { UserError } from '../src/lib/errors.js';
import { fakeInteraction, spyObject, type InteractionKind } from './helpers/discordFakes.js';

const m = messages('fr');
const meetingId = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
const meeting = {
  id: meetingId, guildId: 'g', threadId: 't', title: 'Bureau', description: '', status: 'scheduled', organizerId: 'organizer',
  startsAt: new Date(Date.now() + 86_400_000), durationMin: 60, voiceChannelId: 'v', voiceTemporary: false, autoRecord: false, agendaLocked: false,
} as MeetingRow;
const settings = { guildId: 'g', locale: 'fr', timezone: 'Europe/Paris', managerRoleIds: ['managers'], creatorsRestricted: true, autoVoice: false, voiceChannelId: null, defaultDurationMin: 60 } as unknown as GuildSettingsRow;

/** Actions réservées à l'organisateur et aux gestionnaires (ou, pour dupliquer, aux créateurs). */
const RESTRICTED: Array<[Action['type'], InteractionKind, Partial<Record<string, unknown>>?]> = [
  ['agenda.move', 'button', { itemId: 1, direction: 'up' }],
  ['agenda.remove', 'button', { itemId: 1 }],
  ['agenda.removeConfirm', 'button', { itemId: 1 }],
  ['agenda.lock', 'button', { locked: true }],
  ['report.correct', 'button'],
  ['report.correctSubmit', 'modal'],
  ['report.regen', 'button'],
  ['report.retry', 'button'],
  ['rec.start', 'button'],
  ['rec.stop', 'button'],
  ['rec.next', 'button'],
  ['rec.goto', 'select'],
  ['meeting.manage', 'button'],
  ['meeting.edit', 'button'],
  ['meeting.editSubmit', 'modal'],
  ['meeting.editRetry', 'button'],
  ['meeting.duplicate', 'button'],
  ['meeting.duplicateSubmit', 'modal'],
  ['meeting.autoRecord', 'button'],
  ['meeting.end', 'button'],
  ['meeting.endConfirm', 'button'],
  ['meeting.cancel', 'button'],
  ['meeting.cancelSubmit', 'modal'],
  ['meeting.regen', 'button'],
  ['meeting.regenAll', 'button'],
  ['meeting.regenAllConfirm', 'button'],
];

function context() {
  const services = {
    meetings: spyObject(),
    recordings: spyObject({ isRecording: () => false }),
    pipeline: spyObject({ isQueued: () => false }),
    cards: spyObject(),
    hub: spyObject(),
    repos: spyObject({ getMeeting: async () => meeting, listAgenda: async () => [{ id: 1, authorId: 'someone', title: 'x', detail: '', position: 0 }], listRecordingsForMeeting: async () => [{ id: 'r' }], listSlots: async () => [] }),
  };
  const ctx = {
    ...services,
    config: buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
    log: pino({ level: 'silent' }),
    settings: { get: async () => settings, messages: async () => m },
    client: {},
    owners: { isOwner: () => false },
    optouts: spyObject(),
  };
  return { ctx, services };
}

describe('droits des actions sur une réunion', () => {
  it.each(RESTRICTED)('%s : refusée à un simple membre, sans rien modifier', async (type, kind, extra) => {
    const { ctx, services } = context();
    const { interaction } = fakeInteraction({ kind, userId: 'member', roleIds: ['everyone'] });
    const action = { type, meetingId, ...extra } as Action;
    const error = await handleAction(ctx as never, interaction as never, action as never).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UserError);
    // Refus pour raison de droits, pas une autre erreur (réunion introuvable…).
    expect([m.errors.forbiddenWho(meeting.organizerId, settings.managerRoleIds), m.errors.cannotCreate]).toContain((error as Error).message);
    // Aucun service ni aucune écriture en base (seules les lectures sont tolérées).
    expect(services.meetings.calls()).toEqual([]);
    expect(services.recordings.calls()).toEqual([]);
    expect(services.pipeline.calls()).toEqual([]);
    expect(services.repos.calls().filter((name) => !/^(get|list|has)/.test(name))).toEqual([]);
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('organisateur, rôle gestionnaire, « Gérer les événements » et « Gérer le serveur » passent', async () => {
    for (const who of [
      { userId: 'organizer' },
      { userId: 'x', roleIds: ['managers'] },
      { userId: 'x', permissions: [PermissionFlagsBits.ManageEvents] },
      { userId: 'x', permissions: [PermissionFlagsBits.ManageGuild] },
    ]) {
      const { ctx, services } = context();
      const { interaction } = fakeInteraction({ kind: 'button', ...who });
      await handleAction(ctx as never, interaction as never, { type: 'meeting.autoRecord', meetingId } as never);
      expect(services.meetings.calls()).toEqual(['setAutoRecord']);
    }
  });

  it('le refus nomme l’organisateur et les rôles gestionnaires', async () => {
    const { ctx } = context();
    const { interaction } = fakeInteraction({ kind: 'button', userId: 'member' });
    await expect(handleAction(ctx as never, interaction as never, { type: 'meeting.end', meetingId } as never)).rejects.toThrow(/<@organizer>.*<@&managers>/);
  });
});
