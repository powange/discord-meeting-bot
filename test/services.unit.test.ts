import { GuildScheduledEventStatus, Team } from 'discord.js';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledEvents } from '../src/discord/scheduledEvent.js';
import { handleConsent } from '../src/discord/interactions/consent.js';
import { messages } from '../src/i18n/index.js';
import { AlertService } from '../src/services/alerts.js';
import { OwnersService } from '../src/services/owners.js';
import { request, StorageHttpError } from '../src/storage/http.js';
import { fakeInteraction } from './helpers/discordFakes.js';

const m = messages('fr');
const log = pino({ level: 'silent' });

describe('choix d’enregistrement (consentement)', () => {
  const setup = (refused: string[]) => {
    const set = vi.fn(async () => undefined);
    const ctx = { settings: { messages: async () => m }, optouts: { list: async () => refused, set } };
    return { ctx, set };
  };
  it('ouverture : état actuel de la personne, en privé', async () => {
    const { ctx } = setup(['u1']);
    const { interaction, replies } = fakeInteraction({ kind: 'button', userId: 'u1' });
    await handleConsent(ctx as never, interaction as never, 'open');
    expect(replies[0]!.how).toBe('reply');
    expect(JSON.stringify(replies[0]!.payload)).toContain('**refusez**');
  });
  it('refuser puis accepter : choix enregistré pour cette personne et ce serveur, panneau mis à jour', async () => {
    const { ctx, set } = setup([]);
    const refuse = fakeInteraction({ kind: 'button', userId: 'u2' });
    await handleConsent(ctx as never, refuse.interaction as never, 'refuse');
    expect(set).toHaveBeenLastCalledWith(expect.any(String), 'u2', true);
    expect(JSON.stringify(refuse.replies[0]!.payload)).toContain('**refusez**');
    const accept = fakeInteraction({ kind: 'button', userId: 'u2' });
    await handleConsent(ctx as never, accept.interaction as never, 'accept');
    expect(set).toHaveBeenLastCalledWith(expect.any(String), 'u2', false);
    expect(accept.replies[0]!.how).toBe('update');
  });
});

describe('propriétaires du bot', () => {
  it('ceux du YAML, plus le propriétaire de l’application (ou son équipe)', async () => {
    const solo = new OwnersService(['yaml']);
    await solo.load({ application: { fetch: async () => ({ owner: { id: 'app-owner' } }) } } as never, log);
    expect([solo.isOwner('yaml'), solo.isOwner('app-owner'), solo.isOwner('autre')]).toEqual([true, true, false]);

    const team = Object.create(Team.prototype) as Team;
    Object.assign(team, { members: new Map([['m1', {}], ['m2', {}]]) });
    const teamOwners = new OwnersService([]);
    await teamOwners.load({ application: { fetch: async () => ({ owner: team }) } } as never, log);
    expect([teamOwners.isOwner('m1'), teamOwners.isOwner('m2')]).toEqual([true, true]);
  });
  it('application introuvable : seuls ceux du YAML', async () => {
    const owners = new OwnersService(['yaml']);
    await owners.load({ application: { fetch: async () => Promise.reject(new Error('réseau')) } } as never, log);
    expect([owners.isOwner('yaml'), owners.isOwner('app-owner')]).toEqual([true, false]);
  });
});

describe('alertes', () => {
  const setup = (alertChannelId: string | null) => {
    const sent: string[] = [];
    const channel = { isSendable: () => true, send: vi.fn(async (p: { content: string }) => void sent.push(p.content)) };
    const repos = { getSettingsIfExists: async () => ({ alertChannelId }), listAlertChannels: async () => ['a1', 'a2'] };
    const alerts = new AlertService({ channels: { fetch: async () => channel } } as never, repos as never, log);
    return { alerts, sent };
  };
  it('une alerte par heure et par cause et serveur ; autre cause ou autre serveur : envoyée', async () => {
    const { alerts, sent } = setup('chan');
    await alerts.guild('g1', 'pipeline', 'échec');
    await alerts.guild('g1', 'pipeline', 'encore');
    await alerts.guild('g1', 'disk', 'disque');
    await alerts.guild('g2', 'pipeline', 'autre serveur');
    expect(sent).toEqual(['🚨 échec', '🚨 disque', '🚨 autre serveur']);
  });
  it('sans salon d’alertes : rien n’est envoyé ; alerte globale : tous les salons', async () => {
    const none = setup(null);
    await none.alerts.guild('g1', 'pipeline', 'échec');
    expect(none.sent).toEqual([]);
    await none.alerts.global('disk', 'disque plein');
    expect(none.sent).toEqual(['🚨 disque plein', '🚨 disque plein']);
  });
});

describe('requêtes vers le stockage', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (responses: Response[]) => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${url} ${init.redirect}`);
        return responses.shift()!;
      }),
    );
    return calls;
  };
  it('429 : nouvelle tentative après Retry-After', async () => {
    const calls = stub([new Response('', { status: 429, headers: { 'retry-after': '1' } }), new Response('{}', { status: 200 })]);
    const started = Date.now();
    expect((await request('https://example.org/x', { attempts: 2 })).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(calls).toHaveLength(2);
  });
  it('redirection refusée (jamais suivie), erreur lisible ; 400 non réessayé', async () => {
    const calls = stub([new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })]);
    await expect(request('https://example.org/x')).rejects.toBeInstanceOf(StorageHttpError);
    expect(calls).toEqual(['GET https://example.org/x manual']);
    stub([new Response('{"error":"invalid_grant","error_description":"Token has been revoked"}', { status: 400 })]);
    await expect(request('https://example.org/x')).rejects.toMatchObject({ status: 400, code: 'invalid_grant', message: 'HTTP 400 invalid_grant: Token has been revoked' });
  });
});

describe('événement Discord', () => {
  const guild = (event: { status: GuildScheduledEventStatus; edit: ReturnType<typeof vi.fn> }, editError?: unknown) => ({
    id: 'g',
    scheduledEvents: {
      create: vi.fn(async () => ({ id: 'ev1' })),
      edit: vi.fn(async () => {
        if (editError) throw editError;
      }),
      fetch: vi.fn(async () => ({ ...event, isCompleted: () => event.status === GuildScheduledEventStatus.Completed, isCanceled: () => false, isActive: () => event.status === GuildScheduledEventStatus.Active })),
    },
  });
  const data = { title: 'Bureau', description: '', startsAt: new Date(Date.now() + 86_400_000), durationMin: 60, voiceChannelId: null, location: 'Salon créé 15 min avant' };

  it('réunion passée : pas d’événement ; supprimé à la main : recréé à la mise à jour', async () => {
    const events = new ScheduledEvents(log);
    const g = guild({ status: GuildScheduledEventStatus.Scheduled, edit: vi.fn() }, { code: 10070 });
    expect(await events.create(g as never, { ...data, startsAt: new Date(Date.now() - 1000) })).toBeNull();
    expect(await events.update(g as never, 'ancien', data)).toBe('ev1');
    expect(g.scheduledEvents.create).toHaveBeenCalledOnce();
  });
  it('clôture : passe par « En cours » avant « Terminé » (exigence de Discord)', async () => {
    const event = { status: GuildScheduledEventStatus.Scheduled, edit: vi.fn(async ({ status }: { status: GuildScheduledEventStatus }) => void (event.status = status)) };
    await new ScheduledEvents(log).complete(guild(event) as never, 'ev1');
    expect(event.edit.mock.calls.map((c) => (c[0] as { status: number }).status)).toEqual([GuildScheduledEventStatus.Active, GuildScheduledEventStatus.Completed]);
  });
});
