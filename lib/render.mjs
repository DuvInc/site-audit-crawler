// Open a sample of crawled pages in the local Chrome, compare the DOM after JavaScript with the
// raw HTML, run axe-core, and read lab LCP and CLS. Fills the `rendered` table.
// Optional: needs Google Chrome (or CHROME_PATH). playwright-core and axe-core are loaded only here,
// so a crawl without rendering never touches them.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extract } from './extract.mjs';
import { openCrawlDb } from './db.mjs';

/**
 * @param {string} dir
 * @param {object} [o]
 * @param {number} [o.sample]      how many pages, one per template
 * @param {string} [o.chromePath]  a Chrome or Chromium binary; default: the installed Google Chrome
 * @param {Function} [o.onPage]    called with a one-line summary per page
 */
export async function render(dir, { sample: SAMPLE = 20, chromePath, onPage = () => {} } = {}) {
  const { chromium } = await import('playwright-core');
  const db = openCrawlDb(dir);
  const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');


  // One page per template: the shortest URL of each first path segment, language prefix left out.
  const rows = db.prepare("SELECT url FROM pages WHERE internal=1 AND type='html' AND status=200 ORDER BY length(url)").all();
  const groups = new Map();
  for (const { url } of rows) {
    const seg = new URL(url).pathname.split('/').filter(Boolean).filter((s, i) => !(i === 0 && /^[a-z]{2}(-[a-z]{2})?$/i.test(s)));
    const key = seg.length > 1 ? `${seg[0]}/*` : (seg[0] ?? '/');
    if (!groups.has(key)) groups.set(key, url);
  }
  const sample = [...groups.values()].slice(0, SAMPLE);

  db.exec(`DROP TABLE IF EXISTS rendered;
  CREATE TABLE rendered (url TEXT PRIMARY KEY, title TEXT, h1 TEXT, canonical TEXT, meta_robots TEXT, word_count INTEGER,
    links INTEGER, new_links INTEGER, requests INTEGER, failed_requests INTEGER, transfer_kb INTEGER,
    dom_content_loaded_ms INTEGER, load_ms INTEGER, lcp_ms INTEGER, cls REAL, console_errors TEXT, axe TEXT,
    lcp_tag TEXT, lcp_url TEXT, lcp_lazy INTEGER, lcp_priority TEXT)`);
  const insert = db.prepare('INSERT INTO rendered VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const rawLinks = db.prepare("SELECT DISTINCT dst FROM links WHERE src=? AND type='hyperlink'");

  let browser;
  try {
    browser = await chromium.launch(chromePath ? { executablePath: chromePath, headless: true } : { channel: 'chrome', headless: true });
  } catch (e) {
    db.close();
    throw new Error(`Could not start Chrome (${e.message.split('\n')[0]}). Install Google Chrome or set CHROME_PATH.`);
  }
  const context = await browser.newContext({
    viewport: { width: 412, height: 732 },
    deviceScaleFactor: 2,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 (compatible; SiteAuditCrawler/1.0)',
  });
  for (const url of sample) {
    const page = await context.newPage();
    const errors = [];
    let failed = 0;
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
    page.on('requestfailed', () => failed++);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      const { page: p, links } = extract(await page.content(), url);
      const before = new Set(rawLinks.all(url).map((r) => r.dst));
      const after = new Set(links.filter((l) => l.type === 'hyperlink').map((l) => l.dst));
      const perf = await page.evaluate(
        () =>
          new Promise((resolve) => {
            let lcp = 0;
            let el = null;
            let lcpUrl = null;
            let cls = 0;
            new PerformanceObserver((l) => l.getEntries().forEach((e) => {
              lcp = e.startTime;
              el = e.element;
              lcpUrl = e.url || null;
            })).observe({ type: 'largest-contentful-paint', buffered: true });
            new PerformanceObserver((l) => l.getEntries().forEach((e) => !e.hadRecentInput && (cls += e.value))).observe({ type: 'layout-shift', buffered: true });
            setTimeout(() => {
              const nav = performance.getEntriesByType('navigation')[0];
              const res = performance.getEntriesByType('resource');
              resolve({
                lcp,
                lcpTag: el?.tagName ?? null,
                lcpUrl,
                lcpLazy: el?.getAttribute?.('loading') === 'lazy' ? 1 : 0,
                lcpPriority: el?.getAttribute?.('fetchpriority') ?? null,
                cls,
                dcl: nav.domContentLoadedEventEnd,
                load: nav.loadEventEnd,
                requests: res.length + 1,
                transfer: res.reduce((s, r) => s + (r.transferSize || 0), nav.transferSize || 0),
              });
            }, 500);
          }),
      );
      await page.addScriptTag({ content: axeSource });
      const axe = await page.evaluate(async () => {
        const r = await window.axe.run(document, { resultTypes: ['violations'] });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, tags: v.tags.filter((t) => /^wcag|best/.test(t)) }));
      });
      insert.run(url, p.title, p.h1, p.canonical, p.meta_robots, p.word_count, after.size, [...after].filter((l) => !before.has(l)).length, perf.requests, failed, Math.round(perf.transfer / 1024), Math.round(perf.dcl), Math.round(perf.load), Math.round(perf.lcp), Math.round(perf.cls * 1000) / 1000, JSON.stringify(errors), JSON.stringify(axe), perf.lcpTag, perf.lcpUrl, perf.lcpLazy, perf.lcpPriority);
      onPage(`${url}  ${p.word_count} words, LCP ${Math.round(perf.lcp)} ms, ${axe.length} axe rule(s) failed, ${errors.length} JS error(s)`);
    } catch (e) {
      onPage(`${url}  failed: ${e.message.split('\n')[0]}`);
    }
    await page.close();
  }
  await browser.close();
  db.close();
  return { pages: sample.length };
}
