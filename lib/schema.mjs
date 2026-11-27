// The crawl database's schema and the few helpers every step shares. No Node import here: this file
// runs in Node (node:sqlite) and in a Cloudflare Durable Object (ctx.storage.sql) alike.
//
// A database handle is anything with:
//   exec(sql)                         run one or more statements, no parameters
//   prepare(sql) -> { run, all, get } run one statement with positional parameters
//   transaction?(fn)                  optional: run fn atomically (a Durable Object's transactionSync)
// node:sqlite's DatabaseSync is one as is; lib/durable-object-db.mjs adapts a Durable Object's storage.

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
  struct_sig TEXT, field_evidence TEXT, text_cut INTEGER,
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
CREATE INDEX sitemap_urls_url ON sitemap_urls(url);
CREATE TABLE sitemaps (url TEXT PRIMARY KEY, status INTEGER, kind TEXT, urls INTEGER);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
-- The crawl queue, kept in the database so a crawl can run in batches and resume after a crash.
-- state: 0 queued, 1 claimed by a batch, 2 done. seq keeps breadth-first order.
CREATE TABLE frontier (url TEXT PRIMARY KEY, source TEXT, type_hint TEXT, state INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL);
CREATE INDEX frontier_state_seq ON frontier(state, seq);
`;

/** The columns of the pages table, in order, read from the schema (no PRAGMA: not every SQLite host allows it). */
export const PAGE_COLUMNS = SCHEMA.match(/CREATE TABLE pages \(([\s\S]*?)\n\);/)[1]
  .replace(/--[^\n]*/g, '')
  .split(',')
  .map((c) => c.trim().split(/\s+/)[0])
  .filter(Boolean);

/**
 * Adds the pages columns a newer version declares to a database made by an older one (ALTER TABLE ADD
 * COLUMN, which keeps the rows), so a crawl started before an upgrade still takes the new code's
 * writes. Reads the table's CREATE statement, not PRAGMA. Returns the columns added.
 */
export function upgradeSchema(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pages'").get();
  if (!row?.sql) return [];
  const have = new Set(row.sql.replace(/^[^(]*\(/, '').replace(/--[^\n]*/g, '').split(',').map((c) => c.trim().split(/\s+/)[0].toLowerCase()));
  const missing = PAGE_COLUMNS.filter((c) => !have.has(c.toLowerCase()));
  const types = Object.fromEntries(SCHEMA.match(/CREATE TABLE pages \(([\s\S]*?)\n\);/)[1].replace(/--[^\n]*/g, '').split(',').map((c) => c.trim().split(/\s+/)).filter((p) => p[0]).map((p) => [p[0], p[1] ?? '']));
  for (const c of missing) db.exec(`ALTER TABLE pages ADD COLUMN ${c} ${types[c]}`);
  return missing;
}

export const hasTable = (db, name) => db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").all(name).length > 0;
export const readMeta = (db) => Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));

/** Run fn in one transaction: the host's own when it has one, BEGIN/COMMIT otherwise. */
export function tx(db, fn) {
  if (typeof db.transaction === 'function') return db.transaction(fn);
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// For a long synchronous block that declares what later code reads, where a callback would not fit.
// A Durable Object has no BEGIN: its synchronous writes are already committed together (write
// coalescing), so these are no-ops there. Never put an await between them.
export function begin(db) {
  if (typeof db.transaction !== 'function') db.exec('BEGIN');
}
export function commit(db) {
  if (typeof db.transaction !== 'function') db.exec('COMMIT');
}
