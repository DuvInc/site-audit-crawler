import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { auditFixture } from './helpers.mjs';
import { compare } from '../lib/compare.mjs';

test('compare finds what changed between two crawls, and only that', async () => {
  const ctx = await auditFixture();
  try {
    const oldDir = join(ctx.root, 'old');
    cpSync(ctx.dir, oldDir, { recursive: true });
    const db = new DatabaseSync(join(oldDir, 'crawl.db'));
    const home = `${ctx.site.origin}/`;
    db.prepare('UPDATE pages SET title = ? WHERE url = ?').run('An older title', home);
    db.prepare('DELETE FROM pages WHERE url = ?').run(`${ctx.site.origin}/orphan`);
    db.prepare("DELETE FROM issues WHERE code = 'internal_4xx'").run();
    db.close();
    const out = compare(oldDir, ctx.dir);
    assert.deepEqual(out.title.map((r) => r.url), [home]);
    assert.deepEqual(out.pages_added.map((r) => new URL(r.url).pathname), ['/orphan']);
    assert.deepEqual(out.pages_removed, []);
    assert.deepEqual(out.issues_new.map((r) => r.code).filter((c) => c === 'internal_4xx'), ['internal_4xx']);
    assert.deepEqual(out.status, []);
    assert.match(readFileSync(join(ctx.dir, 'compare.md'), 'utf8'), /## Title \(1\)/);
  } finally {
    await ctx.site.close();
    ctx.cleanup();
  }
});
