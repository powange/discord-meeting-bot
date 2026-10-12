import { ComponentType, type APIButtonComponentWithCustomId, type APIEmbed } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { renderAgendaManager, renderMeetingCard, type CardMeeting } from '../src/discord/embeds/meetingCard.js';
import type { AgendaItem, Rsvp } from '../src/domain/types.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');
const meeting: CardMeeting = {
  id: '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b',
  title: 'Bureau mensuel',
  description: 'Point mensuel',
  startsAt: new Date('2026-10-15T16:00:00Z'),
  durationMin: 90,
  voiceChannelId: '200000000000000000',
  organizerId: '100000000000000000',
  status: 'scheduled',
  autoRecord: false,
  agendaLocked: false,
};

const embedLength = (e: APIEmbed) =>
  (e.title?.length ?? 0) +
  (e.description?.length ?? 0) +
  (e.footer?.text.length ?? 0) +
  (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

const buttons = (card: ReturnType<typeof renderMeetingCard>) =>
  card.components.flatMap((row) => row.components).filter((c): c is APIButtonComponentWithCustomId => c.type === ComponentType.Button);

describe('renderMeetingCard', () => {
  it('affiche date (timestamps Discord), durée, salon et réponses', () => {
    const rsvps: Rsvp[] = [
      { userId: '1', status: 'yes', updatedAt: new Date(1) },
      { userId: '2', status: 'maybe', updatedAt: new Date(2) },
    ];
    const card = renderMeetingCard(meeting, rsvps, [], m);
    const fields = card.embeds[0]!.fields!;
    expect(fields[0]!.value).toBe(`<t:${meeting.startsAt.getTime() / 1000}:F>\n<t:${meeting.startsAt.getTime() / 1000}:R>`);
    expect(fields[1]!.value).toBe('1 h 30');
    expect(fields[2]!.value).toBe('<#200000000000000000>');
    expect(fields.find((f) => f.name.startsWith('✅'))!.value).toBe('<@1>');
    expect(fields.find((f) => f.name.startsWith('❌'))!.value).toBe(m.card.nobody);
    expect(buttons(card).map((b) => b.label)).toEqual(['Présent (1)', 'Peut-être (1)', 'Absent (0)', 'Ajouter un point', "Gérer l'ODJ", 'Modifier']);
  });

  it('reste sous les limites Discord même avec beaucoup de monde et un ODJ plein', () => {
    const rsvps: Rsvp[] = Array.from({ length: 300 }, (_, i) => ({
      userId: String(100000000000000000n + BigInt(i)),
      status: (['yes', 'maybe', 'no'] as const)[i % 3]!,
      updatedAt: new Date(i),
    }));
    const agenda: AgendaItem[] = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      position: i,
      title: 'T'.repeat(100),
      detail: 'D'.repeat(1000),
      authorId: '100000000000000000',
    }));
    const card = renderMeetingCard({ ...meeting, title: 'x'.repeat(100), description: 'y'.repeat(2000) }, rsvps, agenda, m);
    const embed = card.embeds[0]!;
    expect(embedLength(embed)).toBeLessThanOrEqual(6000);
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
    for (const f of embed.fields!) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(embed.fields!.find((f) => f.name.startsWith('✅'))!.value).toMatch(/… et \d+ de plus$/);
  });

  it('désactive les boutons quand la réunion est close', () => {
    const card = renderMeetingCard({ ...meeting, status: 'ended' }, [], [], m);
    expect(buttons(card).every((b) => b.disabled)).toBe(true);
  });

  it("verrou : bouton d'ajout désactivé, titre de l'ODJ marqué", () => {
    const card = renderMeetingCard({ ...meeting, agendaLocked: true }, [], [], m);
    expect(buttons(card).find((b) => b.label === 'Ajouter un point')!.disabled).toBe(true);
    expect(card.embeds[0]!.fields!.some((f) => f.name === m.card.agendaLocked)).toBe(true);
  });
});

describe('renderAgendaManager', () => {
  const agenda: AgendaItem[] = [
    { id: 10, position: 0, title: 'A', detail: '', authorId: '1' },
    { id: 11, position: 1, title: 'B', detail: 'détail', authorId: '1' },
  ];

  it('sans sélection : menu + verrou', () => {
    const view = renderAgendaManager({ id: meeting.id, agendaLocked: false }, agenda, null, m);
    expect(view.components).toHaveLength(2);
    expect(view.components[1]!.components).toHaveLength(1);
  });

  it('premier point sélectionné : « Monter » désactivé', () => {
    const view = renderAgendaManager({ id: meeting.id, agendaLocked: false }, agenda, 10, m);
    const [up, down, remove] = view.components[1]!.components as APIButtonComponentWithCustomId[];
    expect([up!.disabled, down!.disabled, remove!.disabled ?? false]).toEqual([true, false, false]);
    expect(view.content).toContain('**A**');
  });

  it('ODJ vide', () => {
    const view = renderAgendaManager({ id: meeting.id, agendaLocked: true }, [], null, m);
    expect(view.components).toHaveLength(1);
    expect(view.content).toContain(m.agendaManager.empty);
  });
});
