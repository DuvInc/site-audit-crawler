// The AI layer with a fake model client: every step fills its table, a second run is free (cache),
// the per-run budget stops a run, and a dry run sends nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { auditFixture, firedOn, query } from './helpers.mjs';
import { runAi, PROMPTS } from '../lib/ai.mjs';
import { analyze } from '../lib/analyze.mjs';

function fakeClient() {
  const client = {
    decisions: 0,
    chats: 0,
    async decide(body) {
      client.decisions++;
      const { questions } = JSON.parse(body);
      const answers = {};
      for (const [k, q] of Object.entries(questions)) {
        if (q.type === 'choice') {
          const first = Object.keys(q.criteria)[0];
          answers[k] = { choice: first, probabilities: { [first]: 0.9 }, confidence: 0.9 };
        } else answers[k] = { noul: k.startsWith('same_') || k.startsWith('link_') ? 0.9 : k === 'description_fit' ? 0.1 : 0.5 };
      }
      return { answers, cost: 0.0001 };
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

test('the budget is per run and stops the run, keeping what was paid for', async () => {
  const client = fakeClient();
  await assert.rejects(runAi(ctx.dir, { client, budget: 0.0005, cacheFile: join(ctx.root, 'fresh-cache.db') }), /budget of \$0.0005 reached/);
  // Taxonomy costs 0.001 alone: the run stops right after it.
  assert.equal(client.chats, 1);
});
