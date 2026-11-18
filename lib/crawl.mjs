// Crawl one site into a SQLite file: every URL, its response, what its HTML says, every link.
// Breadth first from the start URL, then the sitemap URLs no link led to. Internal URLs are fetched
// one redirect hop at a time (redirect: 'manual'), so chains and loops are visible; external URLs
// are only checked (HEAD, then GET if HEAD is refused).
import { extract } from './extract.mjs';
import { createCrawlDb } from './db.mjs';
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
};

// Bots whose robots.txt treatment the audit reports. Tokens as their operators document them.
export const AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bytespider', 'meta-externalagent', 'Amazonbot'];

const bare = (h) => h.replace(/^www\./, '');
const errName = (e) => e?.cause?.code ?? e?.name ?? String(e);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const typeOf = (ct, hint) => {
  if (/html/i.test(ct)) return 'html';
  if (/^image\//i.test(ct)) return 'image';
  if (/css/i.test(ct)) return 'css';
  if (/javascript|ecmascript/i.test(ct)) return 'js';
  if (/pdf/i.test(ct)) return 'pdf';
  return ct ? 'other' : ({ image: 'image', css: 'css', js: 'js', 'og-image': 'image' }[hint] ?? 'unknown');
};

/**
 * @param {object} o
 * @param {string} o.start       the start URL; its host (without www.) defines what is internal
 * @param {string} o.dir         where crawl.db is written (replaced if it exists)
 * @param {number} [o.max]       URL budget, internal and external together
 * @param {number} [o.concurrency]
 * @param {boolean} [o.external] check external links (true) or ignore them
 * @param {RegExp} [o.include]   internal URLs must match it to be crawled
 * @param {RegExp} [o.exclude]   internal URLs that match it are skipped
 * @param {string} [o.userAgent]
 * @param {string} [o.robotsToken]
 * @param {Function} [o.fetch]   injected for tests; defaults to the global fetch
 * @param {Function} [o.onProgress] called with { done, queued } every 100 URLs
 * @returns {Promise<{ urls: number, fromLinks: number, skipped: number, seconds: number, dir: string }>}
 */
export async function crawl(o) {
  const opt = { ...CRAWL_DEFAULTS, ...o };
  const fetch = opt.fetch ?? globalThis.fetch;
  const START = new URL(opt.start).href;
  const HOST = bare(new URL(START).hostname);
  const origin = new URL(START).origin;
  const isInternal = (u) => bare(new URL(u).hostname) === HOST;
  const headers = { 'user-agent': opt.userAgent, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en' };
  const timeout = () => AbortSignal.timeout(opt.timeoutMs);

  const db = createCrawlDb(opt.dir);
  const PAGE_COLS = db.prepare('PRAGMA table_info(pages)').all().map((c) => c.name);
  const LINK_COLS = ['src', 'dst', 'type', 'anchor', 'alt', 'has_alt', 'dims', 'rel', 'nofollow', 'position', 'target'];
  const norm = (v) => (v === undefined || v === null ? null : typeof v === 'boolean' ? Number(v) : typeof v === 'object' ? JSON.stringify(v) : v);
  const insertPage = db.prepare(`INSERT OR REPLACE INTO pages (${PAGE_COLS.join(',')}) VALUES (${PAGE_COLS.map(() => '?').join(',')})`);
  const insertLink = db.prepare(`INSERT INTO links (${LINK_COLS.join(',')}) VALUES (${LINK_COLS.map(() => '?').join(',')})`);
  const insertText = db.prepare('INSERT OR REPLACE INTO texts VALUES (?, ?)');
  const insertSitemap = db.prepare('INSERT OR REPLACE INTO sitemaps VALUES (?,?,?,?)');
  const insertSitemapUrl = db.prepare('INSERT INTO sitemap_urls VALUES (?,?,?)');
  const setMeta = db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)');
  const savePage = (row) => insertPage.run(...PAGE_COLS.map((c) => norm(row[c])));
  const saveLinks = (src, links) => {
    db.exec('BEGIN');
    for (const l of links) insertLink.run(...LINK_COLS.map((c) => norm(c === 'src' ? src : l[c])));
    db.exec('COMMIT');
  };

  // robots.txt
  let robots = { groups: [], sitemaps: [] };
  let robotsTxt = '';
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers, signal: timeout() });
    robotsTxt = res.ok ? await res.text() : '';
    robots = parseRobots(robotsTxt);
    setMeta.run('robots_status', String(res.status));
    setMeta.run('robots_txt', robotsTxt);
  } catch (e) {
    setMeta.run('robots_status', errName(e));
  }

  // Sitemaps: the ones robots.txt declares, otherwise the usual locations.
  const sitemapUrls = new Set();
  const seenMaps = new Set();
  async function readSitemap(url) {
    if (seenMaps.has(url) || seenMaps.size > 100) return;
    seenMaps.add(url);
    try {
      const res = await fetch(url, { headers, signal: timeout() });
      const xml = res.ok ? await res.text() : '';
      const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+)/g)].map((m) => m[1].trim().replace(/&amp;/g, '&'));
      const isIndex = /<sitemapindex/i.test(xml);
      insertSitemap.run(url, res.status, isIndex ? 'index' : 'urlset', locs.length);
      if (isIndex) {
        for (const loc of locs) await readSitemap(loc);
        return;
      }
      for (const block of xml.split(/<url[\s>]/i).slice(1)) {
        const loc = block.match(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+)/)?.[1]?.trim().replace(/&amp;/g, '&');
        if (!loc) continue;
        try {
          const href = new URL(loc).href;
          sitemapUrls.add(href);
          insertSitemapUrl.run(href, url, block.match(/<lastmod>\s*([^<\s]+)/)?.[1] ?? null);
        } catch {}
      }
    } catch (e) {
      insertSitemap.run(url, 0, errName(e), 0);
    }
  }
  const declared = robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`, `${origin}/sitemap-index.xml`, `${origin}/sitemap_index.xml`];
  setMeta.run('sitemaps_declared_in_robots', String(robots.sitemaps.length));
  for (const s of declared) await readSitemap(s);

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
      const body = await res.text();
      return { status: res.status, content_type: res.headers.get('content-type'), bytes: body.length, vary: res.headers.get('vary') };
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

  // The queue
  const seen = new Set();
  const queue = [];
  let qi = 0;
  let active = 0;
  let done = 0;
  let skipped = 0;
  function enqueue(url, source, typeHint) {
    if (seen.has(url)) return;
    if (source !== 'start' && isInternal(url) && ((opt.include && !opt.include.test(url)) || (opt.exclude && opt.exclude.test(url)))) return;
    if (seen.size >= opt.max) {
      skipped++;
      return;
    }
    seen.add(url);
    queue.push({ url, source, typeHint });
  }

  async function checkExternal(url, typeHint) {
    let last = { status: 0, error: 'unknown' };
    for (const method of ['HEAD', 'GET']) {
      const t0 = performance.now();
      try {
        const res = await fetch(url, { method, headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });
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

  async function processUrl({ url, source, typeHint }) {
    const u = new URL(url);
    const internal = isInternal(url);
    const row = { url, internal, source, in_sitemap: sitemapUrls.has(url) };
    if (!internal) {
      savePage({ ...row, type: typeOf('', typeHint), ...(await checkExternal(url, typeHint)) });
      return;
    }
    if (!robotsAllows(robots, u.pathname + u.search, opt.robotsToken)) {
      savePage({ ...row, type: typeOf('', typeHint), blocked_robots: 1 });
      return;
    }
    let res;
    const t0 = performance.now();
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url, { headers, redirect: 'manual', signal: timeout() });
        // One retry on a 5xx: a single hiccup should not become a finding.
        if (res.status >= 500 && attempt === 0) {
          res.body?.cancel().catch(() => {});
          await sleep(1000);
          continue;
        }
        break;
      } catch (e) {
        if (attempt === 0) continue;
        savePage({ ...row, type: typeOf('', typeHint), status: 0, error: errName(e) });
        return;
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
        saveLinks(url, [{ dst: target.href, type: 'redirect' }]);
        if (isInternal(target.href) || opt.external) enqueue(target.href, 'redirect', typeHint);
      } catch {}
      savePage(row);
      return;
    }
    if (row.type !== 'html') {
      const length = Number(res.headers.get('content-length'));
      // Without a Content-Length, an image is downloaded to be measured: its weight is a finding.
      if (!length && row.type === 'image') row.size_bytes = (await res.arrayBuffer()).byteLength;
      else {
        res.body?.cancel().catch(() => {});
        row.size_bytes = length || null;
      }
      savePage(row);
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    row.total_ms = Math.round(performance.now() - t0);
    // Uncompressed size: Googlebot's 2 MB limit applies to the decompressed document.
    row.size_bytes = buf.length;
    if (res.status === 200) {
      const { page, links, text } = extract(buf.toString('utf8'), url);
      Object.assign(row, page);
      saveLinks(url, links);
      insertText.run(url, text);
      for (const l of links) if (isInternal(l.dst) || opt.external) enqueue(l.dst, 'link', l.type);
    }
    savePage(row);
  }

  async function worker() {
    for (;;) {
      if (qi < queue.length) {
        const job = queue[qi++];
        active++;
        try {
          await processUrl(job);
        } catch (e) {
          savePage({ url: job.url, internal: isInternal(job.url), source: job.source, status: 0, error: `crawler: ${e.message}` });
        }
        active--;
        if (++done % 100 === 0) opt.onProgress?.({ done, queued: queue.length - qi });
      } else if (active === 0) return;
      else await sleep(25);
    }
  }
  const run = () => Promise.all(Array.from({ length: opt.concurrency }, worker));

  const started = Date.now();
  setMeta.run('start_url', START);
  setMeta.run('host', HOST);
  setMeta.run('user_agent', opt.userAgent);
  setMeta.run('started_at', new Date().toISOString());
  enqueue(START, 'start');
  await run();
  const fromLinks = seen.size;
  // Sitemap URLs that no link led to: orphans, still worth auditing.
  for (const s of sitemapUrls) if (isInternal(s)) enqueue(s, 'sitemap');
  await run();
  const seconds = Math.round((Date.now() - started) / 1000);
  setMeta.run('finished_at', new Date().toISOString());
  setMeta.run('seconds', String(seconds));
  setMeta.run('sitemap_urls', String(sitemapUrls.size));
  setMeta.run('skipped_over_max', String(skipped));
  db.exec('CREATE INDEX links_dst ON links(dst); CREATE INDEX links_src ON links(src);');
  db.close();
  return { urls: seen.size, fromLinks, skipped, seconds, dir: opt.dir };
}
