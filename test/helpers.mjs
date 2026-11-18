import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFixtureSite } from './fixture-site.mjs';
import { crawl } from '../lib/crawl.mjs';
import { analyze } from '../lib/analyze.mjs';

export function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'site-audit-'));
  return { root, dir: join(root, 'localhost', '2026-01-01'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Crawl and analyse the fixture site. The caller closes the site and cleans up. */
export async function auditFixture() {
  const site = await startFixtureSite();
  const tmp = tempDir();
  await crawl({ start: `${site.origin}/`, dir: tmp.dir });
  const summary = analyze(tmp.dir);
  return { site, ...tmp, summary };
}

export function query(dir, sql, ...args) {
  const db = new DatabaseSync(join(dir, 'crawl.db'));
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}

/** The URL paths a control fired on. */
export const firedOn = (dir, code) => query(dir, 'SELECT url FROM issues WHERE code = ?', code).map((r) => new URL(r.url).pathname).sort();
