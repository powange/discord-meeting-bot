import { describe, expect, it, vi } from 'vitest';
import type { MeetingRow } from '../src/db/schema.js';
import { askInvites, handleDraft } from '../src/discord/interactions/creation.js';
import { nextInviteState } from '../src/discord/embeds/invite.js';
import { decode, type DraftType } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';
import { UserError } from '../src/lib/errors.js';
import { fakeInteraction } from './helpers/discordFakes.js';

const m = messages('fr');

function setup(opts: { nudgeRoleId?: string | null; createError?: Error } = {}) {
  const create = vi.fn(async () => {
    if (opts.createError) throw opts.createError;
    return { id: 'meet1', threadId: 'post1' } as MeetingRow;
  });
  const inviteRoles = vi.fn(async () => undefined);
  const ctx = {
    settings: { get: async () => ({ nudgeRoleId: opts.nudgeRoleId ?? null }), messages: async () => m },
    meetings: { inviteRoles },
  };
  let draftId = '';
  const start = async (kind: 'meeting' | 'poll' = 'meeting') => {
    const { interaction, replies } = fakeInteraction({ kind: 'modal', userId: 'u1' });
    await askInvites(ctx as never, interaction as never, { kind, title: 'Bureau', when: 'mardi 21/10 à 18h00', retryId: 'v1:meeting:createRetry', create });
    const payload = replies.at(-1)!.payload as { content: string; components: Array<{ components: Array<{ custom_id?: string }> }> };
    const ids = payload.components.flatMap((r) => r.components.map((c) => c.custom_id ?? ''));
    draftId = (decode(ids.find((id) => id.startsWith('v1:draft:create:'))!) as { draftId: string }).draftId;
    return { payload, ids };
  };
  const click = async (verb: string, extra: { roles?: string[]; userId?: string } = {}) => {
    const { interaction, replies } = fakeInteraction({ kind: verb === 'roles' ? 'select' : 'button', userId: extra.userId ?? 'u1' });
    Object.assign(interaction, { isRoleSelectMenu: () => verb === 'roles', isStringSelectMenu: () => false, roles: new Map((extra.roles ?? []).map((r) => [r, {}])) });
    await handleDraft(ctx as never, interaction as never, { type: `draft.${verb}` as DraftType, draftId });
    return replies.at(-1)!.payload as { content: string; components: unknown[] };
  };
  return { start, click, create, inviteRoles };
}

describe('création en deux temps : « Qui inviter ? »', () => {
  it('après le formulaire : rien n’est créé ; explication de chaque choix, mention à la création, relance', async () => {
    const s = setup({ nudgeRoleId: 'r0' });
    const { payload, ids } = await s.start();
    expect(s.create).not.toHaveBeenCalled();
    expect(payload.content).toContain('**mentionnées dès la création**');
    expect(payload.content).toContain('**relancées au premier rappel**');
    expect(payload.content).toContain('**↩️ Par défaut** : personne n\'est mentionné à la création ; <@&r0>');
    expect(payload.content).toContain('**🚫 Personne** : aucune mention, aucune relance.');
    expect(payload.content).toContain(m.invite.current(m.invite.summaryDefault('<@&r0>')));
    expect(ids.map((id) => decode(id)?.type ?? id)).toEqual(['draft.roles', 'draft.everyone', 'draft.default', 'draft.none', 'draft.create', 'meeting.createRetry', 'draft.cancel']);
  });

  it('sans rôle relancé dans /config : pas de « Par défaut », « Personne » toujours proposé', async () => {
    const s = setup();
    const { payload, ids } = await s.start('poll');
    expect(payload.content).not.toContain('Par défaut');
    expect(payload.content).toContain('la veille de la fin des réponses');
    expect(ids.map((id) => decode(id)?.type ?? id)).toContain('draft.none');
    expect(ids.map((id) => decode(id)?.type ?? id)).not.toContain('draft.default');
  });

  it('rôles choisis puis Créer : création, puis invitation de ces rôles', async () => {
    const s = setup();
    await s.start();
    const after = await s.click('roles', { roles: ['r1', 'r2'] });
    expect(after.content).toContain(m.invite.current(m.invite.summaryRoles('<@&r1> <@&r2>')));
    const done = await s.click('create');
    expect(s.create).toHaveBeenCalledOnce();
    expect(s.inviteRoles).toHaveBeenCalledWith(expect.anything(), 'meet1', ['r1', 'r2'], false);
    expect(done.content).toBe(m.invite.created('meeting', 'post1', m.invite.summaryRoles('<@&r1> <@&r2>')));
    expect(done.components).toEqual([]);
  });

  it('Personne : enregistré (aucune relance) ; Par défaut : rien à enregistrer', async () => {
    const none = setup({ nudgeRoleId: 'r0' });
    await none.start();
    await none.click('none');
    await none.click('create');
    expect(none.inviteRoles).toHaveBeenCalledWith(expect.anything(), 'meet1', [], true);
    const def = setup({ nudgeRoleId: 'r0' });
    await def.start();
    await def.click('create');
    expect(def.inviteRoles).not.toHaveBeenCalled();
  });

  it('Annuler : rien n’est créé ; brouillon inconnu ou d’une autre personne : expiré', async () => {
    const s = setup();
    await s.start();
    expect((await s.click('none', { userId: 'intrus' })).content).toBe(m.invite.expired);
    await s.start();
    expect((await s.click('cancel')).content).toBe(m.invite.cancelled);
    expect((await s.click('create')).content).toBe(m.invite.expired);
    expect(s.create).not.toHaveBeenCalled();
  });

  it('création refusée (forum supprimé…) : erreur affichée, le brouillon reste pour réessayer', async () => {
    const s = setup({ createError: new UserError('Forum introuvable') });
    await s.start();
    const r = await s.click('create');
    expect(r.content.startsWith('❌ Forum introuvable')).toBe(true);
    expect(r.components.length).toBeGreaterThan(0);
  });
});

describe('choix des invitations', () => {
  it('Tout le monde se combine aux rôles ; Personne et Par défaut effacent les rôles', () => {
    let s = nextInviteState({ roleIds: [], none: false }, 'g', 'roles', ['r1']);
    s = nextInviteState(s, 'g', 'everyone');
    expect(s).toEqual({ roleIds: ['r1', 'g'], none: false });
    expect(nextInviteState(s, 'g', 'roles', ['r2'])).toEqual({ roleIds: ['r2', 'g'], none: false });
    expect(nextInviteState(s, 'g', 'none')).toEqual({ roleIds: [], none: true });
    expect(nextInviteState({ roleIds: [], none: true }, 'g', 'default')).toEqual({ roleIds: [], none: false });
  });
});
