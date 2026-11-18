// Google Search Console, joined to an analysed crawl. Read-only. What it stores in crawl.db:
//   gsc_pages         clicks, impressions, CTR and position per page, plus, for URLs Google shows that
//                     the crawl never met, what they answer today
//   gsc_queries       queries per page (incomplete by design: Google hides rare queries)
//   gsc_site_queries  the site's top queries
//   gsc_inspect       URL inspection of indexable pages Google never showed, best linked first
//   meta.gsc          the site total read WITHOUT dimension (the only true total), the window, the sitemaps
// The transport is injected: lib/google.mjs (your own API access) or lib/treg.mjs.
import { openCrawlDb, readMeta } from './db.mjs';

export const GSC_DEFAULTS = { days: 90, inspect: 40, lagDays: 3 };

const bare = (h) => h.replace(/^www\./, '');

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/** The Search Console property for a host: a domain property first, then URL-prefix ones. */
export async function findProperty(transport, host) {
  const sites = (await transport('webmasters/v3/sites'))?.siteEntry ?? [];
  const urls = sites.map((s) => s.siteUrl);
  const wanted = [`sc-domain:${host}`, `https://${host}/`, `https://www.${host}/`, `http://${host}/`, `http://www.${host}/`];
  const found = wanted.find((w) => urls.includes(w));
  if (!found) throw new Error(`No Search Console property for ${host} on this account. Properties seen: ${urls.join(', ') || 'none'}.`);
  return found;
}

/**
 * @param {string} dir
 * @param {object} o
 * @param {Function} o.transport   (path, body?) => Promise<json>
 * @param {string} [o.source]      a label for the report: 'google' or 'treg'
 * @param {string} [o.property]    e.g. sc-domain:example.com; found automatically when left out
 * @param {number} [o.days]
 * @param {number} [o.inspect]     URL inspections (Google's quota: 2,000 a day per property)
 * @param {Date}   [o.today]
 * @param {Function} [o.fetch]     for the status check of URLs the crawl never met
 * @param {Function} [o.onWarning]
 */
export async function importSearchConsole(dir, o) {
  const { transport, source = 'google', days = GSC_DEFAULTS.days, inspect = GSC_DEFAULTS.inspect, today = new Date(), fetch = globalThis.fetch, onWarning = () => {} } = o;
  const db = openCrawlDb(dir);
  try {
    const all = (sql, ...a) => db.prepare(sql).all(...a);
    const meta = readMeta(db);
    const HOST = meta.host;
    const property = o.property ?? (await findProperty(transport, HOST));
    const base = `webmasters/v3/sites/${encodeURIComponent(property)}`;

    // Final data lags two to three days: stop three days back.
    const day = (d) => d.toISOString().slice(0, 10);
    const end = new Date(today.getTime() - GSC_DEFAULTS.lagDays * 86400000);
    const start = new Date(end.getTime() - (days - 1) * 86400000);
    const range = { startDate: day(start), endDate: day(end) };
    const query = (extra) => transport(`${base}/searchAnalytics/query`, { ...range, rowLimit: 25000, ...extra });

    db.exec(`DROP TABLE IF EXISTS gsc_pages; DROP TABLE IF EXISTS gsc_queries; DROP TABLE IF EXISTS gsc_site_queries; DROP TABLE IF EXISTS gsc_inspect;
CREATE TABLE gsc_pages (url TEXT PRIMARY KEY, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL, same_site INTEGER, in_crawl INTEGER, status_now INTEGER, redirect_now TEXT);
CREATE TABLE gsc_queries (url TEXT, query TEXT, clicks INTEGER, impressions INTEGER, position REAL);
CREATE TABLE gsc_site_queries (query TEXT PRIMARY KEY, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL);
CREATE TABLE gsc_inspect (url TEXT PRIMARY KEY, verdict TEXT, coverage TEXT, last_crawl TEXT, google_canonical TEXT, user_canonical TEXT, page_fetch TEXT, robots TEXT);`);

    const [total, byPage, byPageQuery, byQuery, sitemaps] = await Promise.all([
      // No dimension: the only request whose total is not trimmed by Google's privacy filtering.
      query({ rowLimit: undefined }),
      query({ dimensions: ['page'] }),
      query({ dimensions: ['page', 'query'] }),
      query({ dimensions: ['query'], rowLimit: 5000 }),
      transport(`${base}/sitemaps`).catch(() => ({})),
    ]);

    // Google reports jump links (#section) as separate rows: fold them into their page.
    const clean = (u) => u.split('#')[0];
    const fold = (rows, keyOf) => {
      const m = new Map();
      for (const r of rows ?? []) {
        const k = keyOf(r);
        const g = m.get(k) ?? m.set(k, { keys: r.keys, clicks: 0, impressions: 0, weighted: 0 }).get(k);
        g.clicks += r.clicks;
        g.impressions += r.impressions;
        g.weighted += r.position * r.impressions;
      }
      return [...m.entries()].map(([k, g]) => ({ k, ...g, position: g.impressions ? g.weighted / g.impressions : null }));
    };
    const known = new Set(all('SELECT url FROM pages').map((r) => r.url));
    const pages = fold(byPage.rows, (r) => clean(r.keys[0]));
    const insPage = db.prepare('INSERT INTO gsc_pages VALUES (?,?,?,?,?,?,?,?,?)');
    const unknown = [];
    db.exec('BEGIN');
    for (const p of pages) {
      const sameSite = bare(new URL(p.k).hostname) === HOST ? 1 : 0;
      const inCrawl = known.has(p.k) ? 1 : 0;
      insPage.run(p.k, p.clicks, p.impressions, p.impressions ? p.clicks / p.impressions : 0, p.position, sameSite, inCrawl, null, null);
      if (sameSite && !inCrawl) unknown.push(p.k);
    }
    const insQuery = db.prepare('INSERT INTO gsc_queries VALUES (?,?,?,?,?)');
    for (const r of fold(byPageQuery.rows, (x) => `${clean(x.keys[0])}\n${x.keys[1]}`)) insQuery.run(clean(r.keys[0]), r.keys[1], r.clicks, r.impressions, r.position);
    const insSiteQuery = db.prepare('INSERT OR REPLACE INTO gsc_site_queries VALUES (?,?,?,?,?)');
    for (const r of byQuery.rows ?? []) insSiteQuery.run(r.keys[0], r.clicks, r.impressions, r.ctr, r.position);
    db.exec('COMMIT');

    // URLs Google shows that the crawl never met: an old URL redirected (fine), an error (lost
    // traffic) or a 200 no link reaches (an orphan). What do they answer today?
    const setStatus = db.prepare('UPDATE gsc_pages SET status_now=?, redirect_now=? WHERE url=?');
    await pool(unknown.slice(0, 500), 5, async (url) => {
      try {
        const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': meta.user_agent ?? 'SiteAuditCrawler/1.0' }, signal: AbortSignal.timeout(15000) });
        res.body?.cancel().catch(() => {});
        const loc = res.headers.get('location');
        setStatus.run(res.status, loc ? new URL(loc, url).href : null, url);
      } catch {
        setStatus.run(0, null, url);
      }
    });

    const silent = all(`SELECT url FROM pages WHERE internal=1 AND type='html' AND status=200 AND indexable=1
      AND url NOT IN (SELECT url FROM gsc_pages) ORDER BY link_score DESC LIMIT ?`, inspect);
    const insInspect = db.prepare('INSERT OR REPLACE INTO gsc_inspect VALUES (?,?,?,?,?,?,?,?)');
    let inspected = 0;
    await pool(silent, 3, async ({ url }) => {
      try {
        const r = (await transport('v1/urlInspection/index:inspect', { inspectionUrl: url, siteUrl: property })).inspectionResult?.indexStatusResult ?? {};
        insInspect.run(url, r.verdict ?? null, r.coverageState ?? null, r.lastCrawlTime ?? null, r.googleCanonical ?? null, r.userCanonical ?? null, r.pageFetchState ?? null, r.robotsTxtState ?? null);
        inspected++;
      } catch (e) {
        onWarning(`inspection failed for ${url}: ${e.message.slice(0, 120)}`);
      }
    });

    const t = total.rows?.[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: null };
    const result = {
      property,
      source,
      ...range,
      total: t,
      by_page_sum: { clicks: pages.reduce((s, p) => s + p.clicks, 0), impressions: pages.reduce((s, p) => s + p.impressions, 0) },
      sitemaps: (sitemaps.sitemap ?? []).map((s) => ({ path: s.path, last_downloaded: s.lastDownloaded, pending: s.isPending ?? false, errors: Number(s.errors), warnings: Number(s.warnings), submitted: Number(s.contents?.[0]?.submitted ?? 0), indexed: Number(s.contents?.[0]?.indexed ?? 0) })),
    };
    db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('gsc', JSON.stringify(result));
    return { ...result, pages: pages.length, unknown: unknown.length, pageQueryRows: byPageQuery.rows?.length ?? 0, inspected };
  } finally {
    db.close();
  }
}
