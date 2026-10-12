import { RSVP_STATUSES, type RsvpStatus } from './types.js';

/**
 * customId persistants : tout l'état nécessaire est encodé dans l'id (pas de collecteur en mémoire),
 * ce qui permet aux boutons de fonctionner après un redémarrage. Préfixe de version pour pouvoir
 * changer le format sans casser les anciens messages.
 */
export type Action =
  | { type: 'rsvp'; meetingId: string; status: RsvpStatus }
  | { type: 'agenda.add'; meetingId: string }
  | { type: 'agenda.addSubmit'; meetingId: string }
  | { type: 'agenda.manage'; meetingId: string }
  | { type: 'agenda.select'; meetingId: string }
  | { type: 'agenda.move'; meetingId: string; itemId: number; direction: 'up' | 'down' }
  | { type: 'agenda.remove'; meetingId: string; itemId: number }
  | { type: 'agenda.lock'; meetingId: string; locked: boolean }
  | { type: 'meeting.edit'; meetingId: string }
  | { type: 'meeting.editSubmit'; meetingId: string }
  | { type: 'report.retry'; meetingId: string }
  | { type: 'tx'; action: TxAction; backendId: number | null }
  | { type: 'rec.start'; meetingId: string }
  | { type: 'rec.stop'; meetingId: string }
  | { type: 'meeting.create' }
  | { type: 'meeting.createSubmit' };

/** Actions du panneau des serveurs de transcription (`backendId` : serveur visé, sinon null). */
export const TX_ACTIONS = ['select', 'up', 'down', 'toggle', 'test', 'delete', 'confirmDelete', 'edit', 'editSubmit', 'add', 'addSubmit', 'testAll'] as const;
export type TxAction = (typeof TX_ACTIONS)[number];

const VERSION = 'v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encode(action: Action): string {
  const parts: Array<string | number> = [VERSION];
  switch (action.type) {
    case 'rsvp':
      parts.push('rsvp', action.meetingId, action.status);
      break;
    case 'agenda.move':
      parts.push('agenda', 'move', action.meetingId, action.itemId, action.direction);
      break;
    case 'agenda.remove':
      parts.push('agenda', 'remove', action.meetingId, action.itemId);
      break;
    case 'agenda.lock':
      parts.push('agenda', 'lock', action.meetingId, action.locked ? 1 : 0);
      break;
    case 'meeting.create':
      parts.push('meeting', 'create');
      break;
    case 'tx':
      parts.push('tx', action.action, action.backendId ?? '-');
      break;
    case 'meeting.createSubmit':
      parts.push('meeting', 'createSubmit');
      break;
    default: {
      const [group, verb] = action.type.split('.') as [string, string];
      parts.push(group, verb, action.meetingId);
    }
  }
  const id = parts.join(':');
  if (id.length > 100) throw new Error(`customId trop long (${id.length}) : ${id}`);
  return id;
}

/** Décode un customId ; renvoie `null` pour tout ce qui n'est pas à nous ou est malformé. */
export function decode(customId: string): Action | null {
  const [version, group, ...rest] = customId.split(':');
  if (version !== VERSION || group === undefined) return null;

  if (group === 'rsvp') {
    const [meetingId, status] = rest;
    if (!isUuid(meetingId) || !RSVP_STATUSES.includes(status as RsvpStatus) || rest.length !== 2) return null;
    return { type: 'rsvp', meetingId, status: status as RsvpStatus };
  }

  if (group === 'tx') {
    const [action, id] = rest;
    if (rest.length !== 2 || !TX_ACTIONS.includes(action as TxAction)) return null;
    if (id === '-') return { type: 'tx', action: action as TxAction, backendId: null };
    const backendId = toId(id);
    return backendId === null ? null : { type: 'tx', action: action as TxAction, backendId };
  }

  const [verb, meetingId, a, b] = rest;
  if (group === 'meeting' && rest.length === 1) {
    if (verb === 'create') return { type: 'meeting.create' };
    if (verb === 'createSubmit') return { type: 'meeting.createSubmit' };
  }
  if (!isUuid(meetingId)) return null;

  if (group === 'meeting') {
    if (rest.length !== 2) return null;
    if (verb === 'edit') return { type: 'meeting.edit', meetingId };
    if (verb === 'editSubmit') return { type: 'meeting.editSubmit', meetingId };
    return null;
  }

  if (group === 'report') {
    return verb === 'retry' && rest.length === 2 ? { type: 'report.retry', meetingId } : null;
  }

  if (group === 'rec') {
    if (rest.length !== 2) return null;
    if (verb === 'start') return { type: 'rec.start', meetingId };
    if (verb === 'stop') return { type: 'rec.stop', meetingId };
    return null;
  }

  if (group === 'agenda') {
    switch (verb) {
      case 'add':
      case 'addSubmit':
      case 'manage':
      case 'select':
        return rest.length === 2 ? { type: `agenda.${verb}`, meetingId } : null;
      case 'move': {
        const itemId = toId(a);
        if (itemId === null || (b !== 'up' && b !== 'down') || rest.length !== 4) return null;
        return { type: 'agenda.move', meetingId, itemId, direction: b };
      }
      case 'remove': {
        const itemId = toId(a);
        return itemId !== null && rest.length === 3 ? { type: 'agenda.remove', meetingId, itemId } : null;
      }
      case 'lock':
        return (a === '1' || a === '0') && rest.length === 3 ? { type: 'agenda.lock', meetingId, locked: a === '1' } : null;
    }
  }
  return null;
}

function isUuid(value: string | undefined): value is string {
  return value !== undefined && UUID_RE.test(value);
}

function toId(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,10}$/.test(value)) return null;
  return Number(value);
}
