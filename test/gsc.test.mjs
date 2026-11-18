// Search Console joined to the fixture crawl through a fake transport, and the treg transport
// through a fake process. No Google account, no treg install.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { auditFixture, firedOn, query } from './helpers.mjs';
import { importSearchConsole, findProperty } from '../lib/gsc.mjs';
import { analyze } from '../lib/analyze.mjs';
import { tregTransport } from '../lib/treg.mjs';

let ctx;
const calls = [];
before(async () => {
  ctx = await auditFixture();
  const o = ctx.site.origin;
  const row = (keys, clicks, impressions, position) => ({ keys, clicks, impressions, ctr: clicks / impressions, position });
  const fake = async (path, body) => {
    calls.push({ path, body });
    if (path === 'webmasters/v3/sites') return { siteEntry: [{ siteUrl: 'https://other.example/' }, { siteUrl: 'sc-domain:localhost' }] };
    if (path.endsWith('/sitemaps')) return { sitemap: [] };
    if (path === 'v1/urlInspection/index:inspect') return { inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed', userCanonical: body.inspectionUrl, googleCanonical: `${o}/` } } };
    const dims = body.dimensions ?? [];
    if (!dims.length) return { rows: [row([], 20, 2000, 9)] };
    if (dims.join() === 'page') {
      return { rows: [
        row([`${o}/`], 3, 900, 9), // on page 1, almost no click: gsc_ctr_gap, well linked: gsc_striking_distance
        row([`${o}/blog/post-1`], 0, 300, 12), // weakly linked, close to page 1: gsc_striking_weak_links
        row([`${o}/blog/post-1#setup`], 0, 20, 14), // a jump link, folded into its page
        row([`${o}/about`], 2, 60, 20),
        row([`${o}/team`], 1, 50, 22),
        row([`${o}/gone-page`], 0, 15, 30), // answers 404 today: gsc_lost_page
        row([`${o}/old-url`], 0, 12, 25), // redirects today: gsc_old_url
        row([`${o}/noindex-page`], 0, 30, 40), // gsc_non_indexable_with_impressions
      ] };
    }
    if (dims.join() === 'page,query') {
      return { rows: [row([`${o}/about`, 'fixture widgets'], 1, 50, 20), row([`${o}/team`, 'fixture widgets'], 0, 40, 22), row([`${o}/`, 'widgets home'], 3, 800, 9)] };
    }
    return { rows: [row(['widgets home'], 3, 800, 9)] };
  };
  await importSearchConsole(ctx.dir, { transport: fake, source: 'google', inspect: 3, today: new Date('2026-06-04T12:00:00Z') });
  analyze(ctx.dir);
});
after(async () => {
  await ctx.site.close();
  ctx.cleanup();
});

test('the property is found among the account properties', async () => {
  const p = await findProperty(async () => ({ siteEntry: [{ siteUrl: 'https://www.example.com/' }] }), 'example.com');
  assert.equal(p, 'https://www.example.com/');
  await assert.rejects(findProperty(async () => ({ siteEntry: [] }), 'example.com'), /No Search Console property/);
});

test('the window ends three days back, and the site total is read without dimension', () => {
  const first = calls.find((c) => c.path.endsWith('/searchAnalytics/query'));
  assert.equal(first.body.endDate, '2026-06-01');
  assert.equal(first.body.startDate, '2026-03-04');
  const meta = JSON.parse(query(ctx.dir, "SELECT value FROM meta WHERE key='gsc'")[0].value);
  assert.equal(meta.total.impressions, 2000);
  assert.equal(meta.property, 'sc-domain:localhost');
});

test('jump links are folded into their page', () => {
  const [p] = query(ctx.dir, "SELECT impressions FROM gsc_pages WHERE url LIKE '%/blog/post-1'");
  assert.equal(p.impressions, 320);
  assert.equal(query(ctx.dir, "SELECT count(*) AS n FROM gsc_pages WHERE url LIKE '%#%'")[0].n, 0);
});

const EXPECTED = {
  gsc_ctr_gap: ['/'],
  gsc_striking_distance: ['/'],
  gsc_striking_weak_links: ['/blog/post-1'],
  gsc_lost_page: ['/gone-page'],
  gsc_old_url: ['/old-url'],
  gsc_non_indexable_with_impressions: ['/noindex-page'],
  gsc_query_cannibalisation: ['/about'],
};
for (const [code, paths] of Object.entries(EXPECTED)) {
  test(`${code} fires on ${paths.join(', ')}`, () => assert.deepEqual(firedOn(ctx.dir, code), paths));
}

test('URL inspection covers indexable pages Google never showed, and flags a canonical Google did not keep', () => {
  assert.equal(query(ctx.dir, 'SELECT count(*) AS n FROM gsc_inspect')[0].n, 3);
  assert.equal(firedOn(ctx.dir, 'gsc_not_indexed').length, 3);
  assert.ok(firedOn(ctx.dir, 'gsc_canonical_differs').length >= 2);
});

test('treg transport: calls the CLI with the path and the body, and surfaces a Search Console error', async () => {
  const seen = [];
  const ok = tregTransport({ exec: async (file, args) => (seen.push([file, ...args]), { stdout: JSON.stringify({ result: { rows: [] }, _treg: { http_status: 200 } }) }) });
  assert.deepEqual(await ok('webmasters/v3/sites/x/searchAnalytics/query', { a: 1 }), { rows: [] });
  assert.deepEqual(seen[0], ['treg', '--json', 'call', 'google-search-console', 'webmasters/v3/sites/x/searchAnalytics/query', '--data', '{"a":1}']);
  const denied = tregTransport({ exec: async () => ({ stdout: JSON.stringify({ result: {}, _treg: { http_status: 403 } }) }) });
  await assert.rejects(denied('webmasters/v3/sites'), /403/);
  const missing = tregTransport({ exec: async () => { throw Object.assign(new Error('spawn treg ENOENT'), { code: 'ENOENT' }); } });
  await assert.rejects(missing('webmasters/v3/sites'), /treg is not installed/);
});
