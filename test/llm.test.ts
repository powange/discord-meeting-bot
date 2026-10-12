import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractJson, LlmClient } from '../src/ai/llm/client.js';
import { meetingSummarySchema } from '../src/ai/llm/schema.js';
import { sanitize, summarizeMeeting, type SummaryContext } from '../src/ai/llm/summarize.js';

/** Serveur chat/completions simulé : `reply` décide du contenu selon la requête. */
let reply: (body: { messages: Array<{ role: string; content: string }> }) => string = () => '{}';
/** Formats refusés par le serveur simulé (comme LM Studio qui refuse json_object). */
let rejectFormats: string[] = [];
const requests: Array<{ body: { model: string; messages: Array<{ role: string; content: string }>; response_format: unknown }; auth?: string }> = [];
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const format = body.response_format?.type ?? 'none';
    if (rejectFormats.includes(format)) {
      requests.push({ body, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
      return res.writeHead(400, { 'content-type': 'application/json' }).end(`{"error":"'response_format.type' must be 'json_schema' or 'text'"}`);
    }
    requests.push({ body, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    res
      .writeHead(200, { 'content-type': 'application/json', 'x-litellm-model-id': 'ollama-pc1' })
      .end(JSON.stringify({ model: 'qwen3:14b', choices: [{ message: { content: reply(body) } }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const llm = () => new LlmClient({ baseUrl: base, apiKey: 'k', model: 'summary', chunkTokens: 6000, temperature: 0.2, timeoutSec: 30 });
const ctx: SummaryContext = {
  title: 'Bureau',
  description: '',
  date: 'lundi 12/10/2026',
  participants: ['Alice', 'Bob'],
  agenda: [
    { id: 1, title: 'Budget', detail: '' },
    { id: 2, title: 'Fête', detail: '' },
  ],
};
const topic = (agendaItemId: number | null, title: string, decisions: string[] = []) => ({
  agendaItemId,
  title,
  summary: `Résumé ${title}`,
  decisions,
  actions: [],
  openQuestions: [],
});

describe('extractJson', () => {
  it('blocs ```json et raisonnement <think> ignorés', () => {
    expect(extractJson('<think>hmm {pas ça}</think>\n```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('Voici : {"a":{"b":2}} merci')).toBe('{"a":{"b":2}}');
  });
});

describe('LlmClient', () => {
  it('sortie structurée (json_schema), modèle, clé, et trace du déploiement LiteLLM', async () => {
    rejectFormats = [];
    reply = () => JSON.stringify({ overview: 'ok', topics: [] });
    const r = await llm().json([{ role: 'user', content: 'x' }], meetingSummarySchema);
    expect(r).toMatchObject({ value: { overview: 'ok', topics: [] }, model: 'qwen3:14b', deployment: 'ollama-pc1' });
    const sent = requests.at(-1)!;
    expect(sent).toMatchObject({ body: { model: 'summary', response_format: { type: 'json_schema' } }, auth: 'Bearer k' });
    const schema = (sent.body.response_format as { json_schema: { schema: { required: string[] } } }).json_schema.schema;
    expect(schema.required).toEqual(['overview', 'topics']); // tous les champs demandés au modèle
  });

  it('format refusé par le serveur : repli json_schema → json_object → sans format, puis mémorisé', async () => {
    rejectFormats = ['json_schema', 'json_object'];
    reply = () => '{"overview":"repli","topics":[]}';
    const client = llm();
    const before = requests.length;
    expect((await client.json([{ role: 'user', content: 'x' }], meetingSummarySchema)).value.overview).toBe('repli');
    const formats = requests.slice(before).map((r) => (r.body.response_format as { type?: string } | undefined)?.type ?? 'none');
    expect(formats).toEqual(['json_schema', 'json_object', 'none']);
    await client.json([{ role: 'user', content: 'x' }], meetingSummarySchema);
    expect((requests.at(-1)!.body.response_format as unknown) ?? 'none').toBe('none'); // pas de nouvel essai inutile
    rejectFormats = [];
  });

  it('JSON invalide : une correction est demandée', async () => {
    let n = 0;
    reply = () => (n++ === 0 ? '{"topics": "pas une liste"}' : '{"overview":"corrigé","topics":[]}');
    const r = await llm().json([{ role: 'user', content: 'x' }], meetingSummarySchema);
    expect(r.value.overview).toBe('corrigé');
    expect(requests.at(-1)!.body.messages.at(-1)!.content).toMatch(/invalide/);
  });

  it('toujours invalide : erreur explicite', async () => {
    reply = () => 'pas de json';
    await expect(llm().json([{ role: 'user', content: 'x' }], meetingSummarySchema)).rejects.toThrow(/invalide après correction/);
  });
});

describe('summarizeMeeting', () => {
  it('réunion courte : une seule passe', async () => {
    reply = () => JSON.stringify({ overview: 'Synthèse', topics: [topic(1, 'Budget', ['Budget voté'])] });
    const r = await summarizeMeeting(llm(), ctx, ['[18:00:00] Alice : On vote le budget.'], 6000);
    expect(r.passes).toBe(1);
    expect(r.summary.topics[0]).toMatchObject({ agendaItemId: 1, decisions: ['Budget voté'] });
    expect(r.models).toEqual(['qwen3:14b (ollama-pc1)']);
  });

  it('réunion longue : passes par morceau puis fusion', async () => {
    const before = requests.length;
    reply = (body) => {
      const prompt = body.messages.at(-1)!.content;
      if (prompt.includes('résumés partiels')) return JSON.stringify({ overview: 'Fusion', topics: [topic(1, 'Budget', ['A', 'B']), topic(2, 'Fête')] });
      return JSON.stringify({ overview: 'Partiel', topics: [topic(1, 'Budget', ['A'])] });
    };
    const lines = Array.from({ length: 40 }, (_, i) => `[18:${String(i).padStart(2, '0')}:00] Alice : ${'blabla '.repeat(60)}`);
    const progress: number[] = [];
    const r = await summarizeMeeting(llm(), ctx, lines, 1500, (p) => progress.push(p));
    const calls = requests.slice(before);
    const maps = calls.filter((c) => c.body.messages.at(-1)!.content.includes("Voici l'extrait")).length;
    expect(maps).toBeGreaterThan(1);
    expect(calls.length).toBe(r.passes);
    expect(r.summary.overview).toBe('Fusion');
    expect(progress).toEqual(Array.from({ length: r.passes }, (_, i) => i + 1));
  });
});

describe('sanitize', () => {
  it('id d’ordre du jour inconnu → hors ODJ ; sujet vide retiré', () => {
    const out = sanitize({ overview: '', topics: [topic(99, 'X'), { ...topic(1, 'Vide'), summary: '' }] }, ctx);
    expect(out.topics).toEqual([{ ...topic(null, 'X') }]);
  });
});
