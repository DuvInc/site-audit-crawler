// Google Search Console joined to a crawl on disk: importSearchConsoleDb (gsc-core.mjs) on <dir>/crawl.db.
import { openCrawlDb } from './db.mjs';
import { importSearchConsoleDb } from './gsc-core.mjs';

export { importSearchConsoleDb, findProperty, GSC_DEFAULTS } from './gsc-core.mjs';

/** Join Search Console to the analysed crawl in `dir`. Options: see importSearchConsoleDb. */
export async function importSearchConsole(dir, o) {
  const db = openCrawlDb(dir);
  try {
    return await importSearchConsoleDb(db, o);
  } finally {
    db.close();
  }
}
