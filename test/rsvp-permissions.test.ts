import { describe, expect, it } from 'vitest';
import { canCreateMeeting, canManageMeeting, isManager, type Actor } from '../src/domain/permissions.js';
import { canReschedule, canTransition, isOpen, threadName } from '../src/domain/meeting.js';
import { groupRsvps, nonResponders, reminderTargets } from '../src/domain/rsvp.js';
import type { Rsvp } from '../src/domain/types.js';

const r = (userId: string, status: Rsvp['status'], t: number): Rsvp => ({ userId, status, updatedAt: new Date(t) });

describe('RSVP', () => {
  const rsvps = [r('b', 'yes', 2), r('a', 'yes', 1), r('c', 'maybe', 3), r('d', 'no', 4)];

  it('groupe par statut, dans l’ordre de réponse', () => {
    expect(groupRsvps(rsvps)).toEqual({ yes: ['a', 'b'], maybe: ['c'], no: ['d'] });
  });

  it('les rappels ciblent présents et peut-être', () => {
    expect(reminderTargets(rsvps)).toEqual(['a', 'b', 'c']);
  });

  it('non-répondants (dédoublonnés, exclusions)', () => {
    expect(nonResponders(['a', 'e', 'f', 'e', 'org'], rsvps, ['org'])).toEqual(['e', 'f']);
  });
});

describe('permissions', () => {
  const settings = { managerRoleId: 'mgr', creatorsRestricted: false };
  const member: Actor = { userId: 'u1', roleIds: ['r1'], canManageEvents: false };
  const manager: Actor = { userId: 'u2', roleIds: ['mgr'], canManageEvents: false };
  const eventsAdmin: Actor = { userId: 'u3', roleIds: [], canManageEvents: true };

  it('gestionnaire = rôle configuré ou permission « Gérer les événements »', () => {
    expect(isManager(member, settings)).toBe(false);
    expect(isManager(manager, settings)).toBe(true);
    expect(isManager(eventsAdmin, settings)).toBe(true);
    expect(isManager(manager, { ...settings, managerRoleId: null })).toBe(false);
  });

  it('organisateur ou gestionnaire', () => {
    expect(canManageMeeting({ organizerId: 'u1' }, member, settings)).toBe(true);
    expect(canManageMeeting({ organizerId: 'x' }, member, settings)).toBe(false);
    expect(canManageMeeting({ organizerId: 'x' }, manager, settings)).toBe(true);
  });

  it('création restreinte', () => {
    expect(canCreateMeeting(member, settings)).toBe(true);
    expect(canCreateMeeting(member, { ...settings, creatorsRestricted: true })).toBe(false);
    expect(canCreateMeeting(manager, { ...settings, creatorsRestricted: true })).toBe(true);
  });
});

describe('cycle de vie', () => {
  it('transitions autorisées', () => {
    expect(canTransition('scheduled', 'live')).toBe(true);
    expect(canTransition('live', 'ended')).toBe(true);
    expect(canTransition('ended', 'live')).toBe(false);
    expect(canTransition('cancelled', 'scheduled')).toBe(false);
  });
  it('ouverture et replanification', () => {
    expect([isOpen('scheduled'), isOpen('live'), isOpen('ended'), isOpen('cancelled')]).toEqual([true, true, false, false]);
    expect([canReschedule('scheduled'), canReschedule('live')]).toEqual([true, false]);
  });
  it('nom du post limité à 100 caractères', () => {
    expect(threadName('Bureau', '15/10')).toBe('15/10 · Bureau');
    expect(threadName('x'.repeat(200), '15/10')).toHaveLength(100);
  });
});
