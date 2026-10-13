import { ComponentType, type APIButtonComponentWithCustomId } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { renderHub } from '../src/discord/embeds/hub.js';
import { decode } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');

describe('renderHub', () => {
  it('liste les réunions dans l’ordre chronologique, en cours signalées', () => {
    const out = renderHub(
      [
        { threadId: '3', startsAt: new Date('2026-10-20T16:00:00Z'), status: 'scheduled' },
        { threadId: '1', startsAt: new Date('2026-10-12T16:00:00Z'), status: 'live' },
        { threadId: '2', startsAt: new Date('2026-10-15T16:00:00Z'), status: 'scheduled' },
      ],
      m,
    );
    const lines = out.embeds[0]!.fields![0]!.value.split('\n');
    expect(lines.map((l) => /<#(\d+)>/.exec(l)![1])).toEqual(['1', '2', '3']);
    expect(lines[0]).toContain(m.hub.live);
    expect(lines[1]).not.toContain(m.hub.live);
  });

  it('message vide et bouton de création', () => {
    const out = renderHub([], m);
    expect(out.embeds[0]!.fields![0]!.value).toBe(m.hub.none);
    const button = out.components[0]!.components[0] as APIButtonComponentWithCustomId;
    expect(button.type).toBe(ComponentType.Button);
    expect(decode(button.custom_id)).toEqual({ type: 'meeting.create' });
  });

  it('reste sous 1024 caractères avec beaucoup de réunions', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      threadId: String(100000000000000000n + BigInt(i)),
      startsAt: new Date(Date.UTC(2026, 10, 1 + i)),
      status: 'scheduled' as const,
    }));
    expect(renderHub(many, m).embeds[0]!.fields![0]!.value.length).toBeLessThanOrEqual(1024);
  });

  it('derniers comptes rendus : liens, crochets du titre neutralisés', () => {
    const out = renderHub([], m, [{ title: 'Bureau [octobre]', startsAt: new Date('2026-10-12T16:00:00Z'), url: 'https://discord.com/channels/1/2/3' }]);
    const field = out.embeds[0]!.fields![1]!;
    expect(field.name).toBe(m.hub.recentReports);
    expect(field.value).toContain('[Bureau octobre](https://discord.com/channels/1/2/3)');
    expect(renderHub([], m).embeds[0]!.fields).toHaveLength(1);
  });
});
