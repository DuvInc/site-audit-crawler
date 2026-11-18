// The AI layer with a fake model client: every step fills its table, a second run is free (cache),
// the per-run budget stops a run, and a dry run sends nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { auditFixture, firedOn, query } from './helpers.mjs';
import { runAi, PROMPTS } from '../lib/ai.mjs';
import { analyze } from '../lib/analyze.mjs';

const PRICES = { 'typesafe/jev-1.13': { prompt: 1e-7, completion: 0 }, 'openai/gpt-6-luna': { prompt: 1e-7, completion: 5e-7 } };
// The worst case lib/ai.mjs reserves for a decision call, to make a fake bill exactly that.
const worstDecision = (body) => (Math.ceil(Buffer.byteLength(body) / 2) + 500) * 1e-7;

function fakeClient({ bill } = {}) {
  const client = {
    decisions: 0,
    chats: 0,
    inFlight: 0,
    maxInFlight: 0,
    price: async (model) => PRICES[model] ?? null,
    async decide(body) {
      client.inFlight++;
      client.maxInFlight = Math.max(client.maxInFlight, client.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      client.inFlight--;
      client.decisions++;
      const { questions } = JSON.parse(body);
      const answers = {};
      for (const [k, q] of Object.entries(questions)) {
        if (q.type === 'choice') {
          const first = Object.keys(q.criteria)[0];
          answers[k] = { choice: first, probabilities: { [first]: 0.9 }, confidence: 0.9 };
        } else answers[k] = { noul: k.startsWith('same_') || k.startsWith('link_') ? 0.9 : k === 'description_fit' ? 0.1 : 0.5 };
      }
      return { answers, cost: bill ? bill(body) : 0.0001 };
    },
    async chat({ system }) {
      client.chats++;
      if (system === PROMPTS.taxonomy) {
        return { value: { page_types: [{ key: 'content_page', description: 'Any page.' }], topics: [{ key: 'widgets', description: 'Widgets.' }] }, cost: 0.001 };
      }
      return { value: { target_query: 'fixture widgets guide', summary: 'A page about widgets.' }, cost: 0.0002 };
    },
  };
  return client;
}

let ctx;
before(async () => {
  ctx = await auditFixture();
});
after(async () => {
  await ctx.site.close();
  ctx.cleanup();
});

test('a dry run builds the requests and sends nothing', async () => {
  const logs = [];
  const r = await runAi(ctx.dir, { dry: true, onLog: (l) => logs.push(l), cacheFile: join(ctx.root, 'dry-cache.db') });
  assert.equal(r.spent, 0);
  assert.ok(logs.some((l) => l.startsWith('taxonomy (dry)')));
});

test('every step fills its table, and the judgments become findings', async () => {
  const client = fakeClient();
  const r = await runAi(ctx.dir, { client, budget: 1 });
  const indexable = query(ctx.dir, 'SELECT count(*) AS n FROM pages WHERE internal=1 AND indexable=1')[0].n;
  assert.equal(query(ctx.dir, 'SELECT count(*) AS n FROM ai_pages')[0].n, indexable);
  assert.equal(query(ctx.dir, "SELECT count(*) AS n FROM ai_pages WHERE target_query='fixture widgets guide'")[0].n, indexable);
  assert.ok(query(ctx.dir, 'SELECT count(*) AS n FROM ai_cannibal')[0].n > 0);
  assert.ok(r.spent > 0);
  analyze(ctx.dir);
  assert.equal(firedOn(ctx.dir, 'ai_description_misfit').length, indexable);
  assert.ok(firedOn(ctx.dir, 'ai_cannibalisation').length > 0);
});

test('a second run is answered from the cache and costs nothing', async () => {
  const client = fakeClient();
  const r = await runAi(ctx.dir, { client, budget: 1 });
  assert.equal(client.decisions + client.chats, 0);
  assert.equal(r.spent, 0);
  assert.ok(r.spentAllRuns > 0);
});

test('a dry run prints the worst case without a key', async () => {
  const logs = [];
  const r = await runAi(ctx.dir, { dry: true, pricing: { price: async (m) => PRICES[m] }, cacheFile: join(ctx.root, 'dry2.db'), onLog: (l) => logs.push(l) });
  assert.ok(r.worstCase > 0);
  assert.ok(logs.some((l) => /at most \$/.test(l)));
});

test('the budget is a hard cap, even with many calls in flight', async () => {
  // Every call bills exactly its reserved worst case: the tightest case for the cap.
  const client = fakeClient({ bill: worstDecision });
  const budget = 0.001; // room for about four of the nine page calls
  await assert.rejects(runAi(ctx.dir, { client, budget, steps: ['pages'], concurrency: 12, cacheFile: join(ctx.root, 'cap.db') }), /budget of \$0.001 reached/);
  assert.ok(client.maxInFlight > 1, 'calls ran concurrently');
  assert.ok(client.decisions > 0 && client.decisions < 9, `${client.decisions} calls made`);
  const { DatabaseSync } = await import('node:sqlite');
  const cache = new DatabaseSync(join(ctx.root, 'cap.db'));
  const total = cache.prepare('SELECT sum(cost) AS c FROM cache').get().c;
  cache.close();
  assert.ok(total <= budget, `spent ${total} over a cap of ${budget}`);
});

test('nothing is sent when a call does not fit at all, or when a price is unknown', async () => {
  const client = fakeClient();
  await assert.rejects(runAi(ctx.dir, { client, budget: 0.00001, cacheFile: join(ctx.root, 'tiny.db') }), /budget/);
  assert.equal(client.chats + client.decisions, 0);
  const unpriced = { ...fakeClient(), price: async () => null };
  await assert.rejects(runAi(ctx.dir, { client: unpriced, budget: 1, cacheFile: join(ctx.root, 'unpriced.db') }), /No price/);
});

test('a call billed above its worst case stops every further call', async () => {
  const client = fakeClient({ bill: (body) => worstDecision(body) * 3 });
  await assert.rejects(runAi(ctx.dir, { client, budget: 1, steps: ['pages'], concurrency: 1, cacheFile: join(ctx.root, 'over.db') }), /budget/);
  assert.equal(client.decisions, 1);
});
