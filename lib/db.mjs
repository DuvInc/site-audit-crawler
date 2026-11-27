// The crawl database on disk: one SQLite file per crawl, `<dir>/crawl.db`. Every other step reads and
// adds to it, so an agent (or you, with the sqlite3 shell) can query everything in one place.
// The schema itself lives in schema.mjs, shared with hosts that are not Node.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA, upgradeSchema } from './schema.mjs';

export { SCHEMA, PAGE_COLUMNS, hasTable, readMeta, tx, upgradeSchema } from './schema.mjs';

/** A fresh database for a new crawl: an existing crawl.db in `dir` is replaced. */
export function createCrawlDb(dir) {
  mkdirSync(dir, { recursive: true });
  for (const f of ['crawl.db', 'crawl.db-wal', 'crawl.db-shm']) rmSync(join(dir, f), { force: true });
  const db = new DatabaseSync(join(dir, 'crawl.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** The database of a finished crawl, brought to this version's columns (a crawl from an older one). */
export function openCrawlDb(dir) {
  const file = join(dir, 'crawl.db');
  if (!existsSync(file)) throw new Error(`No crawl in ${dir}: run "site-audit crawl <url>" first.`);
  const db = new DatabaseSync(file);
  upgradeSchema(db);
  return db;
}
