import { ComponentType, type APIButtonComponentWithCustomId, type APIEmbed } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { renderAgendaManager, renderAgendaMessage, renderMeetingCard, shareDetails, type CardMeeting } from '../src/discord/embeds/meetingCard.js';
import type { AgendaItem, Rsvp } from '../src/domain/types.js';
import { messages } from '../src/i18n/index.js';
import { decode } from '../src/domain/customId.js';

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
  it('affiche date (timestamps Discord), durée, salon et réponses, sans ODJ', () => {
    const rsvps: Rsvp[] = [
      { userId: '1', status: 'yes', updatedAt: new Date(1) },
      { userId: '2', status: 'maybe', updatedAt: new Date(2) },
    ];
    const card = renderMeetingCard(meeting, rsvps, m);
    const fields = card.embeds[0]!.fields!;
    expect(fields[0]!.value).toBe(`<t:${meeting.startsAt.getTime() / 1000}:F>\n<t:${meeting.startsAt.getTime() / 1000}:R>`);
    expect(fields[1]!.value).toBe('1 h 30');
    expect(fields[2]!.value).toBe('<#200000000000000000>');
    expect(fields.find((f) => f.name.startsWith('✅'))!.value).toBe('<@1>');
    expect(fields.find((f) => f.name.startsWith('❌'))!.value).toBe(m.card.nobody);
    expect(fields.some((f) => f.name.includes(m.card.agenda))).toBe(false);
    expect(buttons(card).map((b) => b.label)).toEqual(['Présent (1)', 'Peut-être (1)', 'Absent (0)', 'Gérer']);
  });

  it('reste sous les limites Discord même avec beaucoup de monde', () => {
    const rsvps: Rsvp[] = Array.from({ length: 300 }, (_, i) => ({
      userId: String(100000000000000000n + BigInt(i)),
      status: (['yes', 'maybe', 'no'] as const)[i % 3]!,
      updatedAt: new Date(i),
    }));
    const card = renderMeetingCard({ ...meeting, title: 'x'.repeat(100), description: 'y'.repeat(2000) }, rsvps, m);
    const embed = card.embeds[0]!;
    expect(embedLength(embed)).toBeLessThanOrEqual(6000);
    for (const f of embed.fields!) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(embed.fields!.find((f) => f.name.startsWith('✅'))!.value).toMatch(/… et \d+ de plus$/);
  });

  it('enregistrement en cours : mention sur la carte, sans bouton (message de contrôle séparé)', () => {
    const card = renderMeetingCard(meeting, [], m, new Date('2026-10-15T16:02:00Z'));
    expect(card.embeds[0]!.description).toContain('Enregistrement en cours');
    expect(buttons(card).some((b) => decode(b.custom_id)?.type.startsWith('rec.'))).toBe(false);
  });

  it('désactive les boutons quand la réunion est close', () => {
    // Réponses figées ; « Gérer » reste disponible (dupliquer, régénérer le compte rendu).
    expect(buttons(renderMeetingCard({ ...meeting, status: 'ended' }, [], m)).map((b) => [b.label, b.disabled ?? false])).toEqual([
      ['Présent (0)', true],
      ['Peut-être (0)', true],
      ['Absent (0)', true],
      ['Gérer', false],
    ]);
    expect(buttons(renderAgendaMessage({ ...meeting, status: 'cancelled' }, [], m)).every((b) => b.disabled)).toBe(true);
  });
});

describe('renderAgendaMessage', () => {
  const item = (i: number, detail = ''): AgendaItem => ({ id: i, position: i, title: `Point ${i}`, detail, authorId: '100000000000000000' });

  it('liste numérotée avec auteur et aperçu du détail', () => {
    const out = renderAgendaMessage(meeting, [item(1), item(2, 'ligne 1\nligne 2')], m);
    const embed = out.embeds[0]!;
    expect(embed.title).toBe(`📋 ${m.card.agenda}`);
    expect(embed.description).toContain('**1. Point 1**');
    expect(embed.description).toContain('> ligne 1\n> ligne 2');
    expect(buttons(out).map((b) => [b.label, b.disabled ?? false])).toEqual([
      ['Ajouter un point', false],
      ["Gérer l'ordre du jour", false],
    ]);
  });

  it('détail affiché en entier quand tout tient : retours à la ligne gardés, lignes vides retirées, pas de bouton « Lire un point »', () => {
    const detail = 'Bilan des comptes\n\n  Coût de la restauration  \nBar\n4\n5\n6\n7\n8' + ' Lorem'.repeat(100);
    const out = renderAgendaMessage(meeting, [item(1, detail)], m);
    expect(out.embeds[0]!.description).toContain('> Bilan des comptes\n> Coût de la restauration\n> Bar\n> 4\n> 5\n> 6\n> 7\n> 8 Lorem');
    expect(out.embeds[0]!.description).not.toContain('…');
    expect(buttons(out).map((b) => b.label)).not.toContain(m.buttons.readItem);
  });

  it('place partagée équitablement : les détails courts en entier, les longs raccourcis à parts égales', () => {
    expect(shareDetails([10, 500, 2000], 1000)).toEqual([10, 495, 495]);
    expect(shareDetails([10, 20], 1000)).toEqual([10, 20]);
  });


  it('vide', () => {
    expect(renderAgendaMessage(meeting, [], m).embeds[0]!.description).toBe(m.card.agendaEmpty);
  });

  it("verrou : ajout désactivé, titre marqué, pas d'invitation", () => {
    const out = renderAgendaMessage({ ...meeting, agendaLocked: true }, [], m);
    expect(out.embeds[0]!.title).toBe(`📋 ${m.card.agendaLocked}`);
    expect(out.embeds[0]!.footer).toBeUndefined();
    expect(buttons(out).find((b) => b.label === 'Ajouter un point')!.disabled).toBe(true);
  });

  it('25 points longs : sous les limites Discord', () => {
    const agenda = Array.from({ length: 25 }, (_, i) => ({ ...item(i, 'D'.repeat(1000)), title: 'T'.repeat(100) }));
    const embed = renderAgendaMessage(meeting, agenda, m).embeds[0]!;
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
    expect(embedLength(embed)).toBeLessThanOrEqual(6000);
    // Tout ne tient pas : les détails sont raccourcis, et « Lire un point » permet de les lire en entier.
    expect(buttons(renderAgendaMessage(meeting, agenda, m)).map((b) => b.label)).toContain(m.buttons.readItem);
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
    const [edit, up, down, remove] = view.components[1]!.components as APIButtonComponentWithCustomId[];
    expect(decode(edit!.custom_id)).toEqual({ type: 'agenda.edit', meetingId: meeting.id, itemId: 10 });
    expect([up!.disabled, down!.disabled, remove!.disabled ?? false]).toEqual([true, false, false]);
    expect(view.content).toContain('**A**');
  });

  it('mode auteur : seulement « Modifier », ni déplacement, ni retrait, ni verrou', () => {
    const view = renderAgendaManager({ id: meeting.id, agendaLocked: false }, agenda.slice(0, 1), 10, m, 'author');
    const labels = view.components.flatMap((r) => r.components).filter((c) => c.type === ComponentType.Button).map((c) => (c as APIButtonComponentWithCustomId).label);
    expect(labels).toEqual(['Modifier']);
    expect(view.content).toContain(m.agendaManager.titleAuthor);
  });

  it('ODJ vide', () => {
    const view = renderAgendaManager({ id: meeting.id, agendaLocked: true }, [], null, m);
    expect(view.components).toHaveLength(1);
    expect(view.content).toContain(m.agendaManager.empty);
  });
});

describe('carte d’une réunion terminée', () => {
  it('liens Compte rendu et Audio à la place des réponses', () => {
    const links = { report: 'https://discord.com/channels/1/2/3', audio: 'https://discord.com/channels/1/2/4' };
    const card = renderMeetingCard({ ...meeting, status: 'ended' }, [], m, null, links);
    const all = card.components.flatMap((row) => row.components) as Array<{ label?: string; url?: string; custom_id?: string }>;
    expect(all.map((b) => b.label)).toEqual(['Compte rendu', 'Audio', m.buttons.manage]);
    expect(all[0]?.url).toBe(links.report);
  });

  it('sans compte rendu publié : boutons de réponse désactivés comme avant', () => {
    const card = renderMeetingCard({ ...meeting, status: 'ended' }, [], m);
    expect(buttons(card).filter((b) => b.custom_id.includes('rsvp')).every((b) => b.disabled)).toBe(true);
  });
});
