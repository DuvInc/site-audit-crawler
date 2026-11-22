// The audit without Node: what a Cloudflare Durable Object or Workflow relies on. The core imports
// nothing from Node's storage or process modules, a crawl driven batch by batch on a database that
// behaves like a Durable Object's finds what the CLI finds, and a batch that crashed halfway is
// claimed again without duplicating anything.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startFixtureSite } from './fixture-site.mjs';
import { SCHEMA, initCrawl, crawlBatch, analyzeDb, hamming, durableObjectDb } from '../lib/core.mjs';
import { crawl } from '../lib/crawl.mjs';
import { analyze } from '../lib/analyze.mjs';
import { tempDir, query } from './helpers.mjs';

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '../lib');

/** A node:sqlite database that refuses what a Durable Object refuses, behind the real adapter. */
function durableObjectLike() {
  const raw = new DatabaseSync(':memory:');
  const storage = {
    sql: {
      exec(q, ...params) {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(q)) throw new Error('Durable Objects refuse BEGIN: use transactionSync');
        if (/^\s*PRAGMA/i.test(q)) throw new Error('PRAGMA not allowed here');
        if (params.some((v) => v === undefined || typeof v === 'boolean')) throw new TypeError('bad binding');
        if (!params.length && q.includes(';') && q.trim().split(';').filter((x) => x.trim()).length > 1) {
          raw.exec(q);
          return Object.assign([][Symbol.iterator](), { toArray: () => [], rowsWritten: 0 });
        }
        const st = raw.prepare(q);
        const isRead = /^\s*(SELECT|WITH)/i.test(q) || st.columns().length > 0;
        if (isRead) {
          const rows = st.all(...params);
          return Object.assign(rows[Symbol.iterator](), { toArray: () => rows, rowsWritten: 0 });
        }
        const r = st.run(...params);
        return Object.assign([][Symbol.iterator](), { toArray: () => [], rowsWritten: Number(r.changes) });
      },
    },
    transactionSync(fn) {
      raw.exec('BEGIN');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { db: durableObjectDb(storage), raw };
}

let site;
let cli;
before(async () => {
  site = await startFixtureSite();
  cli = tempDir();
  await crawl({ start: `${site.origin}/`, dir: cli.dir });
  analyze(cli.dir);
});
after(async () => {
  await site.close();
  cli.cleanup();
});

test('the core imports nothing from node:sqlite, node:fs, node:path or node:child_process', () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(!/^node:(sqlite|fs|path|child_process|os)$/.test(spec), `${file} imports ${spec}`);
      if (spec.startsWith('.')) visit(join(dirname(file), spec));
    }
  };
  visit(join(LIB, 'core.mjs'));
  assert.ok(seen.size >= 8, `walked ${seen.size} files`);
});

test('a crawl driven in batches on a Durable-Object-like database finds what the CLI finds', async () => {
  const { db } = durableObjectLike();
  db.exec(SCHEMA);
  await initCrawl(db, { start: `${site.origin}/` });
  let batches = 0;
  for (;;) {
    const r = await crawlBatch(db, { size: 7, concurrency: 3 });
    batches++;
    if (r.done) break;
    assert.ok(batches < 200, 'the crawl ends');
  }
  assert.ok(batches > 3, 'it really ran in several batches');
  const { summary } = analyzeDb(db);
  assert.ok(summary.findings > 0);
  const key = (rows) => rows.map((r) => `${r.code} ${new URL(r.url).pathname}`).sort();
  const cloud = key(db.prepare('SELECT code, url FROM issues').all());
  const local = key(query(cli.dir, 'SELECT code, url FROM issues'));
  // Timing controls (TTFB) can differ between two runs; everything else must match.
  const stable = (k) => !/ttfb|slow|response_time/.test(k);
  assert.deepEqual(cloud.filter(stable), local.filter(stable));
  assert.equal(db.prepare('SELECT count(*) AS n FROM pages').get().n, query(cli.dir, 'SELECT count(*) AS n FROM pages')[0].n);
});

test('a batch that crashed after claiming its URLs is claimed again, without duplicate links', async () => {
  const { db, raw } = durableObjectLike();
  db.exec(SCHEMA);
  await initCrawl(db, { start: `${site.origin}/` });
  await crawlBatch(db, { size: 5 });
  // Simulate a crash: the next batch claims URLs, writes some links, then dies before committing.
  const claimed = raw.prepare('SELECT url FROM frontier WHERE state = 0 ORDER BY seq LIMIT 3').all();
  assert.equal(claimed.length, 3);
  for (const { url } of claimed) {
    raw.prepare('UPDATE frontier SET state = 1 WHERE url = ?').run(url);
    raw.prepare("INSERT INTO links (src, dst, type) VALUES (?, 'https://stale.example/', 'hyperlink')").run(url);
  }
  for (;;) if ((await crawlBatch(db, { size: 10 })).done) break;
  assert.equal(raw.prepare("SELECT count(*) AS n FROM links WHERE dst = 'https://stale.example/'").get().n, 0);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM frontier WHERE state < 2').get().n, 0);
  const dupes = raw.prepare('SELECT src, dst, type, anchor, position, count(*) AS n FROM links GROUP BY 1,2,3,4,5 HAVING n > (SELECT 1)').all();
  const cliDupes = query(cli.dir, 'SELECT src, dst, type, anchor, position, count(*) AS n FROM links GROUP BY 1,2,3,4,5 HAVING n > 1').length;
  assert.equal(dupes.length, cliDupes, 'no more repeated links than the page itself has');
});

test('banded near-duplicate search finds exactly the pairs a full comparison finds', () => {
  // Random 64-bit hashes plus planted neighbours 1 to 6 bits away.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const hex8 = () => Math.floor(rnd() * 2 ** 32).toString(16).padStart(8, '0');
  const flip = (h, bits) => {
    let hi = parseInt(h.slice(0, 8), 16);
    let lo = parseInt(h.slice(8), 16);
    for (const b of bits) b < 32 ? (lo ^= 1 << b) : (hi ^= 1 << (b - 32));
    return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
  };
  const hashes = [];
  for (let i = 0; i < 300; i++) {
    const h = hex8() + hex8();
    hashes.push(h);
    if (i % 3 === 0) {
      const n = 1 + (i % 6);
      hashes.push(flip(h, Array.from({ length: n }, (_, k) => (i * 7 + k * 11) % 64)));
    }
  }
  const brute = new Set();
  for (let i = 0; i < hashes.length; i++) for (let j = i + 1; j < hashes.length; j++) if (hamming(hashes[i], hashes[j]) <= 5) brute.add(`${i},${j}`);
  const BANDS = [[0, 3], [3, 6], [6, 9], [9, 12], [12, 14], [14, 16]];
  const banded = new Set();
  for (const band of BANDS) {
    const buckets = new Map();
    hashes.forEach((h, i) => (buckets.get(h.slice(...band)) ?? buckets.set(h.slice(...band), []).get(h.slice(...band))).push(i));
    for (const m of buckets.values()) for (let x = 0; x < m.length; x++) for (let y = x + 1; y < m.length; y++) if (hamming(hashes[m[x]], hashes[m[y]]) <= 5) banded.add(`${m[x]},${m[y]}`);
  }
  assert.ok(brute.size >= 50, `planted pairs found: ${brute.size}`);
  assert.deepEqual([...banded].sort(), [...brute].sort());
});
