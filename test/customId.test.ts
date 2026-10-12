import { describe, expect, it } from 'vitest';
import { decode, encode, type Action } from '../src/domain/customId.js';

const id = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';

describe('customId', () => {
  const actions: Action[] = [
    { type: 'rsvp', meetingId: id, status: 'yes' },
    { type: 'rsvp', meetingId: id, status: 'maybe' },
    { type: 'agenda.add', meetingId: id },
    { type: 'agenda.addSubmit', meetingId: id },
    { type: 'agenda.manage', meetingId: id },
    { type: 'agenda.select', meetingId: id },
    { type: 'agenda.move', meetingId: id, itemId: 42, direction: 'down' },
    { type: 'agenda.remove', meetingId: id, itemId: 7 },
    { type: 'agenda.lock', meetingId: id, locked: true },
    { type: 'agenda.lock', meetingId: id, locked: false },
    { type: 'meeting.edit', meetingId: id },
    { type: 'meeting.editSubmit', meetingId: id },
    { type: 'meeting.create' },
    { type: 'meeting.createSubmit' },
  ];

  it.each(actions)('aller-retour $type', (action) => {
    const encoded = encode(action);
    expect(encoded.length).toBeLessThanOrEqual(100);
    expect(encoded.startsWith('v1:')).toBe(true);
    expect(decode(encoded)).toEqual(action);
  });

  it('format stable (les anciens messages doivent rester cliquables)', () => {
    expect(encode({ type: 'rsvp', meetingId: id, status: 'no' })).toBe(`v1:rsvp:${id}:no`);
    expect(encode({ type: 'agenda.move', meetingId: id, itemId: 3, direction: 'up' })).toBe(`v1:agenda:move:${id}:3:up`);
  });

  it.each([
    'autre-bot:truc',
    `v2:rsvp:${id}:yes`,
    `v1:rsvp:${id}:peut-etre`,
    'v1:rsvp:pas-un-uuid:yes',
    `v1:rsvp:${id}:yes:extra`,
    `v1:agenda:move:${id}:abc:up`,
    `v1:agenda:move:${id}:3:left`,
    `v1:agenda:lock:${id}:2`,
    `v1:agenda:explode:${id}`,
    `v1:meeting:edit:${id}:x`,
    '',
  ])('rejette %s', (raw) => {
    expect(decode(raw)).toBeNull();
  });
});
