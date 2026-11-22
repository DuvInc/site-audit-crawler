// Crawl one site into a SQLite file on disk. The crawl itself is crawl-core.mjs, which runs in batches
// anywhere (Node, a Cloudflare Workflow); this file is the Node loop around it.
import { createCrawlDb } from './db.mjs';
import { CRAWL_DEFAULTS, initCrawl, crawlBatch } from './crawl-core.mjs';

export { CRAWL_DEFAULTS, AI_BOTS, initCrawl, crawlBatch, readBounded } from './crawl-core.mjs';

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
  const db = createCrawlDb(opt.dir);
  try {
    await initCrawl(db, opt);
    let before = 0;
    for (;;) {
      const r = await crawlBatch(db, { fetch: opt.fetch, concurrency: opt.concurrency, size: Infinity, onProgress: opt.onProgress && ((p) => opt.onProgress({ ...p, done: before + p.done })) });
      before += r.processed;
      if (r.done) break;
    }
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
    return {
      urls: Number(meta.seen),
      fromLinks: Number(meta.from_links ?? meta.seen),
      skipped: Number(meta.skipped_over_max ?? 0),
      seconds: Number(meta.seconds),
      dir: opt.dir,
    };
  } finally {
    db.close();
  }
}
