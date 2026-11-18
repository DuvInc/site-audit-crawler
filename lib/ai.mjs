// The AI layer, on top of an analysed crawl. The code picks the candidates, a small model only judges.
//   taxonomy  chat model, 1 call         reads every title and writes the site's page types and topics
//   pages     decision model, 1 per page page type, topic, intent, title and description fit, answer first, thin
//   queries   chat model, 1 per page     the search query the page targets, and a one-line summary
//   cannibal  decision model, anchored   do two pages with close target queries compete for the same search?
//   links     decision model, anchored   a page names another page's subject without linking to it: worth a link?
// Every answer is cached by a hash of the exact request in ai-cache.db (by default next to the crawl
// folders of the site), so an unchanged page costs nothing on the next crawl.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openCrawlDb, hasTable } from './db.mjs';

export const AI_DEFAULTS = {
  decisionModel: 'typesafe/jev-1.13',
  chatModel: 'openai/gpt-6-luna',
  steps: ['taxonomy', 'pages', 'queries', 'cannibal', 'links'],
  budget: 0.5, // dollars per run
  concurrency: 12,
};

// The two prompts of the chat model. Changing a byte changes the cache key of every page, so the
// next run pays again for everything: keep them stable once a site has been audited.
export const PROMPTS = {
  taxonomy: `You design the page taxonomy of one website for an SEO audit. You get its pages, one per line: path | title | h1.
Return two lists.
page_types: 5 to 10 kinds of page by function (for example homepage, product page, use case page, blog article, documentation guide, API reference, template, legal page). Every page must fit exactly one.
topics: 5 to 12 subjects the content is about, independent of the kind of page and of the language. Specific to this site, not generic.
Each entry: a short snake_case key in English and a one-sentence description precise enough for someone else to classify any page with it. No "other" entry.`,
  queries: `For one web page, return:
target_query: the search query this page is built to rank for, as a person would type it in Google. 2 to 6 words, lowercase, in the language of the page, no brand name unless the page is about the brand itself.
summary: what the page offers, one sentence, 160 characters at most, in English.`,
};

/**
 * @param {string} dir
 * @param {object} o
 * @param {{ decide: Function, chat: Function }} [o.client]  lib/openrouter.mjs, or a fake; not needed with dry
 * @param {string[]} [o.steps]
 * @param {number} [o.pilot]     only this many pages, spread over the site
 * @param {number} [o.budget]    dollars for this run; it stops once the budget is reached (a call in flight may add a little)
 * @param {boolean} [o.dry]      build the requests, send nothing
 * @param {string} [o.cacheFile]
 * @param {string} [o.decisionModel]
 * @param {string} [o.chatModel]
 * @param {Function} [o.onLog]
 * @returns {Promise<{ spent: number, spentAllRuns: number }>}
 */
export async function runAi(dir, o = {}) {
  const opt = { ...AI_DEFAULTS, ...o };
  const { client, pilot: PILOT = 0, budget: BUDGET, dry: DRY = false, onLog = () => {} } = opt;
  const STEPS = opt.steps;
  const JEV = opt.decisionModel;
  const LUNA = opt.chatModel;
  if (!DRY && !client) throw new Error('runAi needs a client (lib/openrouter.mjs) unless dry is set.');
  const db = openCrawlDb(dir);
  const cache = new DatabaseSync(opt.cacheFile ?? join(dirname(dir), 'ai-cache.db'));
  try {
    cache.exec(`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, step TEXT, value TEXT, cost REAL, at TEXT);
CREATE TABLE IF NOT EXISTS spend (at TEXT, step TEXT, model TEXT, calls INTEGER, cached INTEGER, cost REAL);`);
    const getCache = cache.prepare('SELECT value FROM cache WHERE key=?');
    const putCache = cache.prepare('INSERT OR REPLACE INTO cache VALUES (?,?,?,?,?)');
    const sha = (s) => createHash('sha1').update(s).digest('hex');
    const all = (sql, ...a) => db.prepare(sql).all(...a);
    const spentBefore = cache.prepare('SELECT coalesce(sum(cost),0) AS c FROM spend').get().c;
    let spent = 0;
    const overBudget = () => spent >= BUDGET;

    async function pool(items, n, fn) {
      const out = new Array(items.length);
      let i = 0;
      await Promise.all(Array.from({ length: n }, async () => {
        while (i < items.length) {
          const k = i++;
          out[k] = await fn(items[k], k);
        }
      }));
      return out;
    }
    function report(step, model, calls, cached, cost) {
      cache.prepare('INSERT INTO spend VALUES (?,?,?,?,?,?)').run(new Date().toISOString(), step, model, calls, cached, cost);
      onLog(`${step}: ${calls} call(s) to ${model}, ${cached} from cache, $${cost.toFixed(5)} (run total $${spent.toFixed(4)}, all runs $${(spentBefore + spent).toFixed(4)})`);
    }

    // Decision model: one item per call, every question about it in that call.
    async function decideAll(step, requests) {
      let cached = 0;
      let calls = 0;
      let cost = 0;
      let stopped = false;
      const answers = await pool(requests, opt.concurrency, async (r) => {
        const body = JSON.stringify({ model: JEV, state: r.state, questions: r.questions });
        const k = sha(body);
        const hit = getCache.get(k);
        if (hit) {
          cached++;
          return JSON.parse(hit.value);
        }
        if (DRY) return null;
        if (overBudget()) {
          stopped = true;
          return null;
        }
        try {
          const res = await client.decide(body);
          calls++;
          cost += res.cost;
          spent += res.cost;
          putCache.run(k, step, JSON.stringify(res.answers), res.cost, new Date().toISOString());
          return res.answers;
        } catch (e) {
          onLog(`  ${step} failed: ${e.message.slice(0, 160)}`);
          return null;
        }
      });
      if (DRY) onLog(`${step} (dry): ${requests.length} request(s), ${cached} cached, about ${Math.round(requests.reduce((s, r) => s + JSON.stringify([r.state, r.questions]).length / 4, 0))} input tokens\n  sample: ${JSON.stringify([requests[0]?.state, requests[0]?.questions]).slice(0, 700)}`);
      else report(step, JEV, calls, cached, cost);
      if (stopped) throw new Error(`budget of $${BUDGET} reached during "${step}": the answers so far are cached, raise --budget to go on`);
      return answers;
    }

    // Chat model: structured output, same cache.
    async function chatAll(step, items, { system, user, schema, maxTokens }) {
      const keys = items.map((it) => sha(JSON.stringify([LUNA, system, user(it), schema])));
      const out = keys.map((k) => {
        const hit = getCache.get(k);
        return hit ? JSON.parse(hit.value) : undefined;
      });
      const todo = items.map((it, i) => ({ it, i })).filter(({ i }) => out[i] === undefined);
      if (DRY) {
        onLog(`${step} (dry): ${items.length} item(s), ${items.length - todo.length} cached\n  sample: ${user(items[0]).slice(0, 500)}`);
        return out;
      }
      let cost = 0;
      let stopped = false;
      let thinking = 0;
      await pool(todo, Math.min(10, opt.concurrency), async ({ it, i }) => {
        if (overBudget()) {
          stopped = true;
          return;
        }
        try {
          const r = await client.chat({ model: LUNA, system, user: user(it), schema, maxTokens });
          cost += r.cost;
          spent += r.cost;
          thinking += r.reasoningTokens ?? 0;
          out[i] = r.value;
          putCache.run(keys[i], step, JSON.stringify(r.value), r.cost, new Date().toISOString());
        } catch (e) {
          onLog(`  ${step} failed: ${e.message.slice(0, 160)}`);
        }
      });
      if (thinking) onLog(`  ${thinking} reasoning tokens billed`);
      report(step, LUNA, todo.length, items.length - todo.length, cost);
      if (stopped) throw new Error(`budget of $${BUDGET} reached during "${step}": the answers so far are cached, raise --budget to go on`);
      return out;
    }

    db.exec(`CREATE TABLE IF NOT EXISTS ai_taxonomy (kind TEXT, key TEXT, description TEXT);
    CREATE TABLE IF NOT EXISTS ai_pages (url TEXT PRIMARY KEY, page_type TEXT, page_type_p REAL, topic TEXT, topic_p REAL, intent TEXT, intent_p REAL,
      title_fit REAL, description_fit REAL, answer_first REAL, thin REAL, error_page REAL, target_query TEXT, summary TEXT);
    CREATE TABLE IF NOT EXISTS ai_cannibal (a TEXT, b TEXT, p REAL, similarity REAL);
    CREATE TABLE IF NOT EXISTS ai_link_opps (target TEXT, source TEXT, phrase TEXT, snippet TEXT, p REAL);`);

    let pages = all(`SELECT p.url, p.title, p.description, p.h1, p.lang, p.word_count, t.text FROM pages p JOIN texts t USING(url)
      WHERE p.internal=1 AND p.type='html' AND p.status=200 AND p.indexable=1 ORDER BY p.url`);
    if (!pages.length) throw new Error('No indexable page: run analyze first.');
    const path = (u) => new URL(u).pathname;
    if (PILOT) {
      const step = Math.max(1, Math.floor(pages.length / PILOT));
      pages = pages.filter((_, i) => i % step === 0).slice(0, PILOT);
    }

    // 1. Taxonomy
    let taxonomy = { page_types: all("SELECT key, description FROM ai_taxonomy WHERE kind='page_type'"), topics: all("SELECT key, description FROM ai_taxonomy WHERE kind='topic'") };
    if (STEPS.includes('taxonomy')) {
      const everything = all("SELECT url, title, h1 FROM pages WHERE internal=1 AND type='html' AND status=200 AND indexable=1 ORDER BY url");
      const every = Math.ceil(everything.length / 400);
      const list = everything.filter((_, i) => i % every === 0).map((p) => `${path(p.url)} | ${p.title ?? ''} | ${p.h1 ?? ''}`).join('\n');
      const list_ = { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, description: { type: 'string' } }, required: ['key', 'description'], additionalProperties: false } };
      const [t] = await chatAll('taxonomy', [list], {
        system: PROMPTS.taxonomy,
        user: (l) => l,
        schema: { type: 'object', properties: { page_types: list_, topics: list_ }, required: ['page_types', 'topics'], additionalProperties: false },
        maxTokens: 1500,
      });
      if (t) {
        taxonomy = t;
        db.exec('DELETE FROM ai_taxonomy');
        for (const kind of ['page_types', 'topics']) for (const e of t[kind]) db.prepare('INSERT INTO ai_taxonomy VALUES (?,?,?)').run(kind.slice(0, -1), e.key, e.description);
        onLog(`  page types: ${t.page_types.map((e) => e.key).join(', ')}\n  topics: ${t.topics.map((e) => e.key).join(', ')}`);
      }
    }

    // 2. One decision call per page, every question about the page in it
    const upsert = (url, cols) => {
      const names = Object.keys(cols);
      db.prepare(`INSERT INTO ai_pages (url, ${names.join(',')}) VALUES (?, ${names.map(() => '?').join(',')})
        ON CONFLICT(url) DO UPDATE SET ${names.map((n) => `${n}=excluded.${n}`).join(',')}`).run(url, ...names.map((n) => cols[n] ?? null));
    };
    if (STEPS.includes('pages') && taxonomy.page_types?.length) {
      const options = (list) => ({ ...Object.fromEntries(list.map((e) => [e.key, e.description])), other: 'none of the above' });
      const requests = pages.map((p) => ({
        state: { path: path(p.url), title: p.title, meta_description: p.description, h1: p.h1, word_count: p.word_count, opening: p.text.slice(0, 1800) },
        questions: {
          page_type: { type: 'choice', instructions: 'What kind of page is this, by its function on the site?', criteria: options(taxonomy.page_types) },
          topic: { type: 'choice', instructions: 'What is the main subject of this page?', criteria: options(taxonomy.topics) },
          intent: { type: 'choice', instructions: 'What does a visitor arriving from a search engine want on this page?', criteria: {
            informational: 'to learn or understand something', commercial: 'to evaluate or compare a product before choosing',
            transactional: 'to sign up, buy, download or use a tool now', navigational: 'to reach a known page of this site, such as login, contact or legal terms' } },
          title_fit: { type: 'noul', instructions: 'Does the title describe what this page actually contains?', criteria: {
            true: 'specific and faithful to the content shown', false: 'vague, generic, misleading or about something else' } },
          description_fit: { type: 'noul', instructions: 'Does the meta description tell a searcher specifically what they will find on this page?', criteria: {
            true: 'specific to this page and faithful', false: 'missing, generic, cut off or about something else' } },
          answer_first: { type: 'noul', instructions: 'Do the first sentences of the opening state plainly what the page offers or answer the question in its title?', criteria: {
            true: 'the point is stated in the first two or three sentences', false: 'it opens with filler, a story, navigation text or teasing before any substance' } },
          thin: { type: 'noul', instructions: 'Is this a thin page, with little information of its own?', criteria: {
            true: 'mostly boilerplate, placeholders or a few generic lines', false: 'has specific, substantive content' } },
          error_page: { type: 'noul', instructions: 'Is this an error page or an empty state rather than real content?', criteria: {
            true: 'a not found, error, empty or coming soon page', false: 'a normal content page' } },
        },
      }));
      const answers = await decideAll('pages', requests);
      answers.forEach((a, i) => {
        if (!a) return;
        upsert(pages[i].url, {
          page_type: a.page_type.choice, page_type_p: a.page_type.confidence, topic: a.topic.choice, topic_p: a.topic.confidence,
          intent: a.intent.choice, intent_p: a.intent.confidence, title_fit: a.title_fit.noul, description_fit: a.description_fit.noul,
          answer_first: a.answer_first.noul, thin: a.thin.noul, error_page: a.error_page.noul,
        });
      });
    }

    // 3. The query each page targets
    if (STEPS.includes('queries')) {
      const out = await chatAll('queries', pages, {
        system: PROMPTS.queries,
        user: (p) => `Path: ${path(p.url)}\nTitle: ${p.title ?? ''}\nH1: ${p.h1 ?? ''}\nMeta description: ${p.description ?? ''}\nOpening: ${p.text.slice(0, 1200)}`,
        schema: { type: 'object', properties: { target_query: { type: 'string' }, summary: { type: 'string' } }, required: ['target_query', 'summary'], additionalProperties: false },
        maxTokens: 150,
      });
      out.forEach((v, i) => v && upsert(pages[i].url, { target_query: v.target_query.toLowerCase().trim(), summary: v.summary.slice(0, 200) }));
    }

    const STOP = new Set('a an the of for to in on with and or your you my our is are how what why best vs from by at as into using use le la les de des du un une et pour avec sur en à au aux der die das und für mit von el los las del con para y que qué cómo comment'.split(' '));
    const tokens = (s) => (s ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) => !STOP.has(w)).map((w) => (w.length > 4 ? w.replace(/s$/, '') : w)) ?? [];
    const ai = new Map(all('SELECT * FROM ai_pages').map((r) => [r.url, r]));
    const known = pages.filter((p) => ai.get(p.url)?.target_query);

    // 4. Cannibalisation: pairs whose target queries share most of their words, judged by the decision model
    if (STEPS.includes('cannibal') && known.length > 1) {
      const sets = new Map(known.map((p) => [p.url, new Set(tokens(ai.get(p.url).target_query))]));
      const byAnchor = new Map();
      for (let i = 0; i < known.length; i++) {
        for (let j = i + 1; j < known.length; j++) {
          const a = known[i];
          const b = known[j];
          if ((a.lang ?? '') !== (b.lang ?? '')) continue;
          const A = sets.get(a.url);
          const B = sets.get(b.url);
          const inter = [...A].filter((w) => B.has(w)).length;
          const sim = inter / (A.size + B.size - inter || 1);
          if (sim < 0.5) continue;
          if (!byAnchor.has(a.url)) byAnchor.set(a.url, []);
          byAnchor.get(a.url).push({ url: b.url, sim });
        }
      }
      const card = (u) => ({ path: path(u), title: known.find((p) => p.url === u).title, target_query: ai.get(u).target_query, summary: ai.get(u).summary });
      const requests = [];
      for (const [a, list] of byAnchor) {
        list.sort((x, y) => y.sim - x.sim);
        for (let o = 0; o < list.length; o += 20) {
          const chunk = list.slice(o, o + 20);
          requests.push({
            a, chunk,
            state: { page: card(a), candidates: chunk.map((c, n) => ({ n: n + 1, ...card(c.url) })) },
            questions: Object.fromEntries(chunk.map((_, n) => [`same_${n + 1}`, {
              type: 'noul', instructions: `Do the page and candidate ${n + 1} answer the same search, so that a search engine would have to pick one of them?`,
              criteria: { true: 'same subject and same intent, a searcher would accept either', false: 'a different subject, audience, format or step, each deserves its own result' },
            }])),
          });
        }
      }
      const answers = await decideAll('cannibal', requests);
      db.exec('DELETE FROM ai_cannibal');
      answers.forEach((ans, i) => ans && requests[i].chunk.forEach((c, n) => db.prepare('INSERT INTO ai_cannibal VALUES (?,?,?,?)').run(requests[i].a, c.url, ans[`same_${n + 1}`].noul, Math.round(c.sim * 100) / 100)));
    }

    // 5. Link opportunities: a page's main content names the subject of another page and has no link to it
    if (STEPS.includes('links') && known.length > 1) {
      // The page's own h1 is blanked out (same length, so offsets hold): a phrase inside it is its subject, not a mention.
      const lower = new Map(known.map((p) => {
        const t = p.text.toLowerCase();
        const h1 = (p.h1 ?? '').toLowerCase();
        return [p.url, h1 && t.includes(h1) ? t.replace(h1, ' '.repeat(h1.length)) : t];
      }));
      const final = (u) => {
        for (let hop = 0; hop < 5; hop++) {
          const r = db.prepare('SELECT redirect_to FROM pages WHERE url=?').get(u)?.redirect_to;
          if (!r) break;
          u = r;
        }
        return u;
      };
      const linked = new Set(all("SELECT DISTINCT src, dst FROM links WHERE type='hyperlink' AND position='content'").map((l) => `${l.src} ${final(l.dst)}`));
      const find = (text, phrase) => {
        for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) {
          if (!/[\p{L}\p{N}]/u.test(text[at - 1] ?? ' ') && !/[\p{L}\p{N}]/u.test(text[at + phrase.length] ?? ' ')) return at;
        }
        return -1;
      };
      // With Search Console loaded (gsc.mjs), the queries Google really shows a page for are phrases to look for too.
      const googleQueries = new Map();
      if (hasTable(db, 'gsc_queries')) {
        const brand = new URL(known[0].url).hostname.replace(/^www\./, '').split('.')[0];
        for (const r of all('SELECT url, query FROM gsc_queries WHERE impressions >= 20 ORDER BY impressions DESC')) {
          if (r.query.includes(brand) || r.query.split(/\s+/).length < 2) continue;
          const list = googleQueries.get(r.url) ?? googleQueries.set(r.url, []).get(r.url);
          if (list.length < 5) list.push(r.query);
        }
      }
      const requests = [];
      for (const t of known) {
        const words = ai.get(t.url).target_query.split(/\s+/);
        const phrases = new Set([ai.get(t.url).target_query, ...(googleQueries.get(t.url) ?? [])]);
        for (let n = words.length - 1; n >= 2; n--) {
          for (let i = 0; i + n <= words.length; i++) {
            const w = words.slice(i, i + n);
            if (!STOP.has(w[0]) && !STOP.has(w[n - 1])) phrases.add(w.join(' '));
          }
        }
        const found = [];
        for (const phrase of [...phrases].sort((x, y) => y.length - x.length)) {
          const holders = known.filter((s) => s.url !== t.url && (s.lang ?? '') === (t.lang ?? '') && find(lower.get(s.url), phrase) >= 0);
          if (!holders.length || holders.length > known.length * 0.2) continue; // too common to be about this page
          for (const s of holders) {
            if (linked.has(`${s.url} ${t.url}`) || found.some((f) => f.source === s.url)) continue;
            const at = find(lower.get(s.url), phrase);
            found.push({ source: s.url, phrase: s.text.slice(at, at + phrase.length), snippet: s.text.slice(Math.max(0, at - 160), at + phrase.length + 160) });
          }
        }
        if (!found.length) continue;
        const chunk = found.slice(0, 12);
        requests.push({
          t, chunk,
          state: {
            target_page: { path: path(t.url), title: t.title, summary: ai.get(t.url).summary },
            passages: chunk.map((f, n) => ({ n: n + 1, from_page: known.find((p) => p.url === f.source).title, phrase: f.phrase, passage: f.snippet })),
          },
          questions: Object.fromEntries(chunk.map((_, n) => [`link_${n + 1}`, {
            type: 'noul', instructions: `In passage ${n + 1}, would turning the phrase into a link to the target page help the reader?`,
            criteria: { true: 'the passage talks about what the target page covers, the link would be a natural next step', false: 'the phrase is used in another sense, in passing, or the target page would add nothing here' },
          }])),
        });
      }
      const answers = await decideAll('links', requests);
      db.exec('DELETE FROM ai_link_opps');
      answers.forEach((ans, i) => ans && requests[i].chunk.forEach((f, n) => db.prepare('INSERT INTO ai_link_opps VALUES (?,?,?,?,?)').run(requests[i].t.url, f.source, f.phrase, f.snippet, ans[`link_${n + 1}`].noul)));
    }

    return { spent, spentAllRuns: spentBefore + spent };
  } finally {
    cache.close();
    db.close();
  }
}
