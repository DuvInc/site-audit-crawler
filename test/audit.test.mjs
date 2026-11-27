// End to end on the fixture site: every planted defect is found where it was planted, and the clean
// home page is spared. No network beyond localhost, no key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditFixture, firedOn, query } from './helpers.mjs';

let ctx;
before(async () => {
  ctx = await auditFixture();
});
after(async () => {
  await ctx.site.close();
  ctx.cleanup();
});

const PLANTED = {
  internal_4xx: ['/missing'],
  internal_blocked_robots: ['/private/secret'],
  redirect_chain: ['/old-page'],
  redirect_loop: ['/loop-a', '/loop-b'],
  redirect_temporary: ['/older-page', '/temp'],
  external_4xx: ['/gone'],
  title_duplicate: ['/about', '/team'],
  description_missing: ['/about'],
  h1_missing: ['/about'],
  content_lorem: ['/about'],
  content_exact_duplicate: ['/dup-a', '/dup-b'],
  canonical_canonicalised: ['/canonicalised'],
  directive_noindex: ['/noindex-page'],
  sitemap_non_indexable: ['/noindex-page'],
  sitemap_orphan: ['/orphan'],
  hreflang_no_return: ['/en/'],
  title_repeated_segment: ['/en/'],
  hreflang_missing_x_default: ['/fr/'],
  content_stale_year: ['/blog/post-1'],
  schema_rich_result_warnings: ['/blog/post-1'],
  schema_rating_not_shown: ['/orphan'],
  geo_no_cited_source: ['/blog/post-1'],
  geo_few_statistics: ['/blog/post-1'],
  image_over_100kb: ['/img/big.png'],
  image_legacy_format: ['/img/big.png'],
  image_missing_alt_attribute: ['/'],
  ai_bots_blocked: ['/'],
  sitemap_no_lastmod: ['/'],
  site_name_schema: ['/'],
};

for (const [code, paths] of Object.entries(PLANTED)) {
  test(`${code} fires on ${paths.join(', ')}`, () => {
    assert.deepEqual(firedOn(ctx.dir, code), [...paths].sort());
  });
}

test('the clean home page is spared the page-level content controls', () => {
  for (const code of ['title_missing', 'title_duplicate', 'description_missing', 'h1_missing', 'h1_multiple', 'canonical_missing', 'content_low', 'content_near_duplicate']) {
    assert.ok(!firedOn(ctx.dir, code).includes('/'), `${code} fired on the home page`);
  }
});

test('near duplicates are not reported for pages that only share a template', () => {
  assert.deepEqual(firedOn(ctx.dir, 'content_near_duplicate'), []);
});

test('depth counts clicks from the start URL, and a redirect costs nothing', () => {
  const depth = Object.fromEntries(query(ctx.dir, 'SELECT url, depth FROM pages WHERE internal=1').map((r) => [new URL(r.url).pathname, r.depth]));
  assert.equal(depth['/'], 0);
  assert.equal(depth['/about'], 1);
  assert.equal(depth['/team'], 1); // linked from the footer of every page
  assert.equal(depth['/older-page'], 1); // behind a 301 from a depth-1 link
  assert.equal(depth['/orphan'], null);
});

test('indexability gives the reason', () => {
  const by = Object.fromEntries(query(ctx.dir, "SELECT url, indexability FROM pages WHERE internal=1 AND type IN ('html', 'unknown')").map((r) => [new URL(r.url).pathname, r.indexability]));
  assert.equal(by['/'], 'Indexable');
  assert.equal(by['/noindex-page'], 'Noindex');
  assert.equal(by['/canonicalised'], 'Canonicalised');
  assert.equal(by['/missing'], 'Client error');
  assert.equal(by['/old-page'], 'Redirected');
  assert.equal(by['/private/secret'], 'Blocked by robots.txt');
});

test('the home page has the highest link score', () => {
  const [top] = query(ctx.dir, 'SELECT url FROM pages WHERE link_score IS NOT NULL ORDER BY link_score DESC LIMIT 1');
  assert.equal(new URL(top.url).pathname, '/');
});

test('summary.json and report.md are written and agree', () => {
  const summary = JSON.parse(readFileSync(join(ctx.dir, 'summary.json'), 'utf8'));
  const report = readFileSync(join(ctx.dir, 'report.md'), 'utf8');
  assert.equal(summary.issues.length, ctx.summary.issues.length);
  assert.ok(summary.rules_run > 100);
  assert.match(report, /^# Site audit: localhost/);
  assert.match(report, new RegExp(`${summary.issues.length} controls with findings`));
  assert.ok(!/\u2014/.test(report), 'no em dash in the report');
});
