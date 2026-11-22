// Post-crawl analysis of a crawl on disk: analyzeDb (analyze-core.mjs) on <dir>/crawl.db, then
// summary.json (what an agent reads first) and report.md next to it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCrawlDb } from './db.mjs';
import { analyzeDb } from './analyze-core.mjs';

export { analyzeDb, CLICK_CURVE } from './analyze-core.mjs';

/** Analyse the crawl in `dir`. Returns the summary, and writes summary.json and report.md next to crawl.db. */
export function analyze(dir) {
  const db = openCrawlDb(dir);
  try {
    const { summary, report } = analyzeDb(db);
    const { findings, ...written } = summary;
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(written, null, 2));
    writeFileSync(join(dir, 'report.md'), report);
    return summary;
  } finally {
    db.close();
  }
}
