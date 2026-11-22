// Crawl one site into a crawl database, in batches that can run anywhere: a loop in Node (crawl.mjs),
// or one batch per step of a Cloudflare Workflow writing to a Durable Object. The queue lives in the
// database (`frontier`), so a batch that crashed halfway is simply claimed again by the next one.
//
// Breadth first from the start URL, then the sitemap URLs no link led to. Internal URLs are fetched
// one redirect hop at a time (redirect: 'manual'), so chains and loops are visible; external URLs
// are only checked (HEAD, then GET if HEAD is refused). Bodies are read with a byte cap.
//
// No Node import: `fetch` is injected, the database is a handle (see schema.mjs).
import { extract } from './extract.mjs';
import { PAGE_COLUMNS, readMeta, tx } from './schema.mjs';
import { parseRobots, robotsAllows } from './robots.mjs';

export const CRAWL_DEFAULTS = {
  max: 5000,
  concurrency: 5,
  external: true,
  userAgent: 'Mozilla/5.0 (compatible; SiteAuditCrawler/1.0; +https://github.com/DuvInc/site-audit-crawler)',
  // The token matched against robots.txt groups. Matching the whole user-agent string would let a
  // group named after a word of the URL above apply by accident.
  robotsToken: 'SiteAuditCrawler',
  timeoutMs: 20000,
  // Googlebot reads the first 2 MB of an HTML document (uncompressed); we read a little more so the
  // size control still sees pages over the limit, and never hold an unbounded body in memory.
  maxBodyBytes: 5 * 1024 * 1024,
  maxSitemaps: 100,
};

// Bots whose robots.txt treatment the audit reports. Tokens as their operators document them.
export const AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bytespider', 'meta-externalagent', 'Amazonbot'];

const LINK_COLS = ['src', 'dst', 'type', 'anchor', 'alt', 'has_alt', 'dims', 'rel', 'nofollow', 'position', 'target'];
const bare = (h) => h.replace(/^www\./, '');
const errName = (e) => e?.cause?.code ?? e?.name ?? String(e);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (v) => (v === undefined || v === null ? null : typeof v === 'boolean' ? Number(v) : typeof v === 'object' ? JSON.stringify(v) : v);
const typeOf = (ct, hint) => {
  if (/html/i.test(ct)) return 'html';
  if (/^image\//i.test(ct)) return 'image';
  if (/css/i.test(ct)) return 'css';
  if (/javascript|ecmascript/i.test(ct)) return 'js';
  if (/pdf/i.test(ct)) return 'pdf';
  return ct ? 'other' : ({ image: 'image', css: 'css', js: 'js', 'og-image': 'image' }[hint] ?? 'unknown');
};
const regex = (r) => (r ? { source: r.source, flags: r.flags } : null);
const unregex = (r) => (r ? new RegExp(r.source, r.flags) : null);

/**
 * Read a response body up to `max` bytes, then cancel the stream. Never `text()` first and measure
 * after: a hostile or broken server can send gigabytes.
 * @returns {Promise<{ bytes: Uint8Array, truncated: boolean }>}
 */
export async function readBounded(res, max) {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes, truncated };
}

/** The settings a crawl was started with, as initCrawl stored them. */
export function crawlSettings(db) {
  const raw = readMeta(db).crawl_settings;
  if (!raw) throw new Error('This database has no crawl: call initCrawl first.');
  const s = JSON.parse(raw);
  return { ...s, include: unregex(s.include), exclude: unregex(s.exclude) };
}

function context(db, o = {}) {
  const s = crawlSettings(db);
  const fetch = o.fetch ?? globalThis.fetch;
  const host = bare(new URL(s.start).hostname);
  const isInternal = (u) => bare(new URL(u).hostname) === host;
  const headers = { 'user-agent': s.userAgent, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en' };
  const timeout = () => AbortSignal.timeout(s.timeoutMs);
  const setMeta = db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)');
  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const counter = (key) => Number(getMeta.get(key)?.value ?? 0);
  const insertFrontier = db.prepare('INSERT OR IGNORE INTO frontier (url, source, type_hint, state, seq) VALUES (?, ?, ?, 0, ?)');
  return { s, fetch, host, isInternal, headers, timeout, setMeta, counter, insertFrontier };
}

/** Add a URL to the queue unless it was seen, is filtered out, or the URL budget is spent. */
function enqueue(db, c, url, source, typeHint) {
  if (source !== 'start' && c.isInternal(url) && ((c.s.include && !c.s.include.test(url)) || (c.s.exclude && c.s.exclude.test(url)))) return;
  const seen = c.counter('seen');
  if (db.prepare('SELECT 1 FROM frontier WHERE url = ?').get(url)) return;
  if (seen >= c.s.max) {
    c.setMeta.run('skipped_over_max', String(c.counter('skipped_over_max') + 1));
    return;
  }
  c.insertFrontier.run(url, source, typeHint ?? null, seen);
  c.setMeta.run('seen', String(seen + 1));
}

/**
 * Start a crawl in an empty crawl database: robots.txt, sitemaps, the soft-404 and AI-readiness
 * probes, and the start URL in the queue. Safe to call again on the same database (it re-reads robots.txt).
 * @param {object} db    a crawl database handle with the schema applied
 * @param {object} o     the crawl options: start, max, external, include, exclude, userAgent, robotsToken, timeoutMs, maxBodyBytes
 * @param {Function} [o.fetch]
 */
export async function initCrawl(db, o) {
  const opt = { ...CRAWL_DEFAULTS, ...o };
  const START = new URL(opt.start).href;
  const settings = {
    start: START,
    max: opt.max,
    external: opt.external,
    include: regex(opt.include),
    exclude: regex(opt.exclude),
    userAgent: opt.userAgent,
    robotsToken: opt.robotsToken,
    timeoutMs: opt.timeoutMs,
    maxBodyBytes: opt.maxBodyBytes,
    maxSitemaps: opt.maxSitemaps,
  };
  db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('crawl_settings', JSON.stringify(settings));
  const c = context(db, opt);
  const { setMeta, headers, timeout, fetch } = c;
  const origin = new URL(START).origin;
  const read = async (res) => new TextDecoder().decode((await readBounded(res, settings.maxBodyBytes)).bytes);

  setMeta.run('start_url', START);
  setMeta.run('host', c.host);
  setMeta.run('user_agent', settings.userAgent);
  setMeta.run('started_at', new Date().toISOString());
  setMeta.run('phase', 'links');

  // robots.txt
  let robots = { groups: [], sitemaps: [] };
  let robotsTxt = '';
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers, signal: timeout() });
    robotsTxt = res.ok ? await read(res) : '';
    if (!res.ok) res.body?.cancel().catch(() => {});
    robots = parseRobots(robotsTxt);
    setMeta.run('robots_status', String(res.status));
    setMeta.run('robots_txt', robotsTxt);
  } catch (e) {
    setMeta.run('robots_status', errName(e));
  }

  // Sitemaps: the ones robots.txt declares, otherwise the usual locations.
  const insertSitemap = db.prepare('INSERT OR REPLACE INTO sitemaps VALUES (?,?,?,?)');
  const insertSitemapUrl = db.prepare('INSERT INTO sitemap_urls VALUES (?,?,?)');
  const seenMaps = new Set();
  async function readSitemap(url) {
    if (seenMaps.has(url) || seenMaps.size > settings.maxSitemaps) return;
    seenMaps.add(url);
    try {
      const res = await fetch(url, { headers, signal: timeout() });
      const xml = res.ok ? await read(res) : '';
      if (!res.ok) res.body?.cancel().catch(() => {});
      const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+)/g)].map((m) => m[1].trim().replace(/&amp;/g, '&'));
      const isIndex = /<sitemapindex/i.test(xml);
      insertSitemap.run(url, res.status, isIndex ? 'index' : 'urlset', locs.length);
      if (isIndex) {
        for (const loc of locs) await readSitemap(loc);
        return;
      }
      const rows = [];
      for (const block of xml.split(/<url[\s>]/i).slice(1)) {
        const loc = block.match(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+)/)?.[1]?.trim().replace(/&amp;/g, '&');
        if (!loc) continue;
        try {
          rows.push([new URL(loc).href, url, block.match(/<lastmod>\s*([^<\s]+)/)?.[1] ?? null]);
        } catch {}
      }
      tx(db, () => {
        for (const r of rows) insertSitemapUrl.run(...r);
      });
    } catch (e) {
      insertSitemap.run(url, 0, errName(e), 0);
    }
  }
  const declared = robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`, `${origin}/sitemap-index.xml`, `${origin}/sitemap_index.xml`];
  setMeta.run('sitemaps_declared_in_robots', String(robots.sitemaps.length));
  for (const s of declared) await readSitemap(s);
  setMeta.run('sitemap_urls', String(db.prepare('SELECT count(DISTINCT url) AS n FROM sitemap_urls').get().n));

  // Does an unknown URL answer 404? A site that answers 200 to anything has soft 404s everywhere.
  try {
    const res = await fetch(`${origin}/site-audit-missing-page-${Date.now()}`, { headers, redirect: 'manual', signal: timeout() });
    res.body?.cancel().catch(() => {});
    setMeta.run('missing_page_status', String(res.status));
  } catch (e) {
    setMeta.run('missing_page_status', errName(e));
  }

  // How the site presents itself to AI crawlers and agents.
  const probe = async (url, extra = {}) => {
    try {
      const res = await fetch(url, { headers: { ...headers, ...extra }, redirect: 'follow', signal: timeout() });
      const { bytes } = await readBounded(res, settings.maxBodyBytes);
      return { status: res.status, content_type: res.headers.get('content-type'), bytes: new TextDecoder().decode(bytes).length, vary: res.headers.get('vary') };
    } catch (e) {
      return { status: 0, error: errName(e) };
    }
  };
  setMeta.run('ai_readiness', JSON.stringify({
    llms_txt: await probe(`${origin}/llms.txt`),
    llms_full_txt: await probe(`${origin}/llms-full.txt`),
    home_as_gptbot: await probe(START, { 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.3; +https://openai.com/gptbot)' }),
    home_as_markdown: await probe(START, { accept: 'text/markdown' }),
    content_signal_in_robots: /content-signal/i.test(robotsTxt),
    bots: Object.fromEntries(AI_BOTS.map((b) => [b, {
      named: robots.groups.some((g) => g.agents.includes(b.toLowerCase())),
      allowed: robotsAllows(robots, '/', b),
    }])),
  }));

  enqueue(db, c, START, 'start');
  return { start: START, sitemapUrls: Number(readMeta(db).sitemap_urls) };
}

async function checkExternal(c, url, typeHint) {
  let last = { status: 0, error: 'unknown' };
  for (const method of ['HEAD', 'GET']) {
    const t0 = performance.now();
    try {
      const res = await c.fetch(url, { method, headers: c.headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      res.body?.cancel().catch(() => {});
      const ct = res.headers.get('content-type') ?? '';
      last = {
        status: res.status,
        content_type: ct,
        type: typeOf(ct, typeHint),
        redirect_to: res.redirected ? res.url : null,
        size_bytes: Number(res.headers.get('content-length')) || null,
        ttfb_ms: Math.round(performance.now() - t0),
      };
      // Many servers refuse HEAD but answer GET.
      if (method === 'HEAD' && res.status >= 400) continue;
      return last;
    } catch (e) {
      last = { status: 0, error: errName(e) };
    }
  }
  return last;
}

/** Fetch and read one URL. Returns what to write; writes nothing (the batch commits everything at once). */
async function processUrl(c, robots, { url, source, type_hint: typeHint }) {
  const u = new URL(url);
  const internal = c.isInternal(url);
  const row = { url, internal, source };
  if (!internal) return { row: { ...row, type: typeOf('', typeHint), ...(await checkExternal(c, url, typeHint)) } };
  if (!robotsAllows(robots, u.pathname + u.search, c.s.robotsToken)) return { row: { ...row, type: typeOf('', typeHint), blocked_robots: 1 } };
  let res;
  const t0 = performance.now();
  for (let attempt = 0; ; attempt++) {
    try {
      res = await c.fetch(url, { headers: c.headers, redirect: 'manual', signal: c.timeout() });
      // One retry on a 5xx: a single hiccup should not become a finding.
      if (res.status >= 500 && attempt === 0) {
        res.body?.cancel().catch(() => {});
        await sleep(1000);
        continue;
      }
      break;
    } catch (e) {
      if (attempt === 0) continue;
      return { row: { ...row, type: typeOf('', typeHint), status: 0, error: errName(e) } };
    }
  }
  const ct = res.headers.get('content-type') ?? '';
  Object.assign(row, {
    status: res.status,
    content_type: ct,
    type: typeOf(ct, typeHint),
    ttfb_ms: Math.round(performance.now() - t0),
    content_encoding: res.headers.get('content-encoding'),
    x_robots_tag: res.headers.get('x-robots-tag'),
    headers: Object.fromEntries(res.headers),
  });
  if (res.status >= 300 && res.status < 400) {
    res.body?.cancel().catch(() => {});
    try {
      const target = new URL(res.headers.get('location'), url);
      target.hash = '';
      row.redirect_to = target.href;
      return { row, links: [{ dst: target.href, type: 'redirect' }], next: [[target.href, 'redirect', typeHint]] };
    } catch {}
    return { row };
  }
  if (row.type !== 'html') {
    const length = Number(res.headers.get('content-length'));
    // Without a Content-Length, an image is downloaded to be measured: its weight is a finding.
    if (!length && row.type === 'image') row.size_bytes = (await readBounded(res, c.s.maxBodyBytes)).bytes.byteLength;
    else {
      res.body?.cancel().catch(() => {});
      row.size_bytes = length || null;
    }
    return { row };
  }
  const { bytes } = await readBounded(res, c.s.maxBodyBytes);
  row.total_ms = Math.round(performance.now() - t0);
  // Uncompressed size: Googlebot's 2 MB limit applies to the decompressed document.
  row.size_bytes = bytes.byteLength;
  if (res.status !== 200) return { row };
  const { page, links, text } = extract(new TextDecoder().decode(bytes), url);
  Object.assign(row, page);
  return { row, links, text, next: links.map((l) => [l.dst, 'link', l.type]) };
}

/**
 * Crawl up to `size` URLs of the queue, `concurrency` at a time. Each worker writes its URL as soon as
 * it is read and takes the next one, so the batch never waits for its slowest URL except at the very
 * end. One batch runs at a time per crawl: URLs a previous batch claimed and never finished (a crash)
 * are queued again first. When the queue is empty after the links, the sitemap URLs no link led to
 * are queued once; when it is empty after those too, the crawl is finished (indexes, timings).
 * @param {object} db
 * @param {object} [o]
 * @param {number} [o.size]          URLs to process in this batch (Infinity: until the queue is empty)
 * @param {number} [o.concurrency]
 * @param {Function} [o.fetch]
 * @param {number} [o.deadline]      a Date.now() value after which no new URL is started
 * @param {boolean} [o.storeTexts]   keep page text in `texts` (default true; only the AI layer and two GEO controls read it)
 * @param {Function} [o.onProgress]  called with { done, queued } every 100 URLs
 * @returns {Promise<{ done: boolean, processed: number, queued: number, seen: number }>}
 */
export async function crawlBatch(db, o = {}) {
  const c = context(db, o);
  const size = o.size ?? 100;
  const concurrency = o.concurrency ?? CRAWL_DEFAULTS.concurrency;
  const meta = readMeta(db);
  const robots = parseRobots(meta.robots_txt ?? '');
  db.prepare('UPDATE frontier SET state = 0 WHERE state = 1').run();

  const nextJob = db.prepare('SELECT url, source, type_hint FROM frontier WHERE state = 0 ORDER BY seq LIMIT 1');
  const claim = db.prepare('UPDATE frontier SET state = 1 WHERE url = ?');
  const insertPage = db.prepare(`INSERT OR REPLACE INTO pages (${PAGE_COLUMNS.join(',')}) VALUES (${PAGE_COLUMNS.map(() => '?').join(',')})`);
  const insertLink = db.prepare(`INSERT INTO links (${LINK_COLS.join(',')}) VALUES (${LINK_COLS.map(() => '?').join(',')})`);
  const insertText = db.prepare('INSERT OR REPLACE INTO texts VALUES (?, ?)');
  const deleteLinks = db.prepare('DELETE FROM links WHERE src = ?');
  const inSitemap = db.prepare('SELECT 1 FROM sitemap_urls WHERE url = ? LIMIT 1');
  const markDone = db.prepare('UPDATE frontier SET state = 2 WHERE url = ?');
  const storeTexts = o.storeTexts ?? true;
  const write = ({ row, links, text, next: found }) => tx(db, () => {
    row.in_sitemap = inSitemap.get(row.url) ? 1 : 0;
    insertPage.run(...PAGE_COLUMNS.map((col) => norm(row[col])));
    // A URL claimed again after a crash must not keep the first attempt's links.
    deleteLinks.run(row.url);
    for (const l of links ?? []) insertLink.run(...LINK_COLS.map((col) => norm(col === 'src' ? row.url : l[col])));
    if (text !== undefined && storeTexts) insertText.run(row.url, text);
    for (const [dst, source, hint] of found ?? []) if (c.isInternal(dst) || c.s.external) enqueue(db, c, dst, source, hint);
    markDone.run(row.url);
  });

  let started = 0;
  let active = 0;
  const worker = async () => {
    for (;;) {
      if (started >= size || (o.deadline && Date.now() > o.deadline)) return;
      const job = nextJob.get();
      if (!job) {
        // Others may still discover URLs: wait for them, stop when nobody is working.
        if (active === 0) return;
        await sleep(20);
        continue;
      }
      claim.run(job.url);
      started++;
      active++;
      let result;
      try {
        result = await processUrl(c, robots, job);
      } catch (e) {
        result = { row: { url: job.url, internal: c.isInternal(job.url), source: job.source, status: 0, error: `crawler: ${e.message}` } };
      }
      write(result);
      active--;
      if (o.onProgress && started % 100 === 0) o.onProgress({ done: started, queued: progress(db, c).queued });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (started) return { done: false, processed: started, ...progress(db, c) };

  if (meta.phase === 'links') {
    // Sitemap URLs that no link led to: orphans, still worth auditing.
    tx(db, () => {
      for (const { url } of db.prepare('SELECT DISTINCT url FROM sitemap_urls').all()) if (c.isInternal(url)) enqueue(db, c, url, 'sitemap');
      c.setMeta.run('phase', 'sitemap');
      c.setMeta.run('from_links', String(c.counter('seen')));
    });
    return { done: false, processed: 0, ...progress(db, c) };
  }
  if (meta.phase !== 'finished') finish(db, c);
  return { done: true, processed: 0, ...progress(db, c) };
}

function progress(db, c) {
  return {
    queued: db.prepare('SELECT count(*) AS n FROM frontier WHERE state < 2').get().n,
    seen: c.counter('seen'),
  };
}

function finish(db, c) {
  const meta = readMeta(db);
  tx(db, () => {
    const seconds = Math.round((Date.now() - Date.parse(meta.started_at)) / 1000);
    c.setMeta.run('finished_at', new Date().toISOString());
    c.setMeta.run('seconds', String(seconds));
    c.setMeta.run('skipped_over_max', String(c.counter('skipped_over_max')));
    c.setMeta.run('phase', 'finished');
  });
  db.exec('CREATE INDEX IF NOT EXISTS links_dst ON links(dst); CREATE INDEX IF NOT EXISTS links_src ON links(src);');
}
