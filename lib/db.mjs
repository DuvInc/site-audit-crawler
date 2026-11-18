// The crawl database: one SQLite file per crawl, `<dir>/crawl.db`. Every other step reads and
// adds to it, so an agent (or you, with the sqlite3 shell) can query everything in one place.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA = `
CREATE TABLE pages (
  url TEXT PRIMARY KEY, internal INTEGER, type TEXT, source TEXT,
  status INTEGER, error TEXT, blocked_robots INTEGER DEFAULT 0, content_type TEXT, redirect_to TEXT,
  ttfb_ms INTEGER, total_ms INTEGER, size_bytes INTEGER, content_encoding TEXT, headers TEXT,
  title TEXT, title_count INTEGER, title_len INTEGER, title_outside_head INTEGER, title_px INTEGER, md_alternate TEXT,
  description TEXT, description_count INTEGER, description_len INTEGER,
  h1 TEXT, h1_count INTEGER, h1_len INTEGER, h2 TEXT, h2_count INTEGER, heading_order_ok INTEGER,
  canonical TEXT, canonical_count INTEGER, canonical_relative INTEGER, canonical_outside_head INTEGER,
  meta_robots TEXT, x_robots_tag TEXT, meta_refresh TEXT, lang TEXT, viewport TEXT, charset TEXT,
  rel_next TEXT, rel_prev TEXT, hreflang TEXT, og TEXT, twitter TEXT,
  schema_types TEXT, schema_formats TEXT, schema_parse_errors INTEGER, schema_json TEXT,
  word_count INTEGER, text_ratio REAL, text_hash TEXT, simhash TEXT, dom_nodes INTEGER, img_count INTEGER,
  mixed_content INTEGER, insecure_forms INTEGER, empty_anchors INTEGER, uncrawlable_links INTEGER,
  unsafe_blank_links INTEGER, has_lorem INTEGER, in_sitemap INTEGER DEFAULT 0,
  -- filled by analyze()
  indexable INTEGER, indexability TEXT, depth INTEGER, inlinks INTEGER, unique_inlinks INTEGER,
  outlinks INTEGER, unique_outlinks INTEGER, external_outlinks INTEGER, link_score REAL,
  near_dup_of TEXT, near_dup_distance INTEGER
);
CREATE TABLE links (
  src TEXT, dst TEXT, type TEXT, anchor TEXT, alt TEXT, has_alt INTEGER, dims INTEGER,
  rel TEXT, nofollow INTEGER DEFAULT 0, position TEXT, target TEXT
);
CREATE TABLE texts (url TEXT PRIMARY KEY, text TEXT);
CREATE TABLE sitemap_urls (url TEXT, sitemap TEXT, lastmod TEXT);
CREATE TABLE sitemaps (url TEXT PRIMARY KEY, status INTEGER, kind TEXT, urls INTEGER);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

/** A fresh database for a new crawl: an existing crawl.db in `dir` is replaced. */
export function createCrawlDb(dir) {
  mkdirSync(dir, { recursive: true });
  for (const f of ['crawl.db', 'crawl.db-wal', 'crawl.db-shm']) rmSync(join(dir, f), { force: true });
  const db = new DatabaseSync(join(dir, 'crawl.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** The database of a finished crawl. */
export function openCrawlDb(dir) {
  const file = join(dir, 'crawl.db');
  if (!existsSync(file)) throw new Error(`No crawl in ${dir}: run "site-audit crawl <url>" first.`);
  return new DatabaseSync(file);
}

export const hasTable = (db, name) => db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").all(name).length > 0;
export const readMeta = (db) => Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
