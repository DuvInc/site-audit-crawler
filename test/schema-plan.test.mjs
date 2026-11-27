import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { extract } from '../lib/extract.mjs';
import { SCHEMA, PAGE_COLUMNS } from '../lib/schema.mjs';
import { roleOf, schemaPlan } from '../lib/schema-plan.mjs';

const tpl = (over) => ({ shape: '/x/*', pages: 10, fields: {}, paths: {}, schema_types: {}, ...over });

test('role: the address, then what the pages show at one place, then what they declare', () => {
  assert.equal(roleOf(tpl({ shape: '/' })).role, 'home');
  assert.equal(roleOf(tpl({ shape: '/privacy-policy' })).role, 'legal');
  assert.equal(roleOf(tpl({ shape: '/kontakt' })).role, 'contact');
  assert.equal(roleOf(tpl({ shape: '/blog/*' })).role, 'article');
  assert.equal(roleOf(tpl({ shape: '/notes/*', fields: { times: 9, authors: 9 }, paths: { times: { path: 'article>time', pages: 9 } } })).why, 'a date at article>time on 9 of 10 pages');
  assert.equal(roleOf(tpl({ shape: '/shop/*', fields: { prices: 10 }, paths: { prices: { path: 'div.price', pages: 10 } } })).role, 'product');
  // A pricing table on comparison pages is not a product: they are comparisons.
  assert.equal(roleOf(tpl({ shape: '/vs/*', fields: { prices: 10 }, paths: { prices: { path: 'td', pages: 10 } } })).role, 'comparison');
  assert.equal(roleOf(tpl({ shape: '/pricing', pages: 1 })).role, 'pricing');
  assert.equal(roleOf(tpl({ shape: '/docs/*/*' })).role, 'docs');
  assert.equal(roleOf(tpl({ shape: '/authors/*' })).role, 'profile');
  assert.equal(roleOf(tpl({ shape: '/careers/*' })).role, 'job');
  assert.equal(roleOf(tpl({ shape: '/stores/*', fields: { addresses: 8, phones: 8 }, paths: { addresses: { path: 'address', pages: 8 }, phones: { path: 'a', pages: 8 } } })).role, 'location');
  assert.equal(roleOf(tpl({ shape: '/guides', pages: 1 }), ['/guides', '/guides/*']).role, 'listing');
  assert.equal(roleOf(tpl({ shape: '/blog', pages: 1, schema_types: { BlogPosting: 1 } }), ['/blog', '/blog/*']).role, 'listing');
  assert.deepEqual(roleOf(tpl({ shape: '/features/*' })), { role: 'other', why: 'no rule fits', decided: 'open' });
});

function crawlOf(pages) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const insert = db.prepare(`INSERT INTO pages (${PAGE_COLUMNS.join(',')}) VALUES (${PAGE_COLUMNS.map(() => '?').join(',')})`);
  for (const [url, html, linkScore = 1] of pages) {
    const row = { url, internal: 1, type: 'html', status: 200, ...extract(html, url).page, link_score: linkScore };
    insert.run(...PAGE_COLUMNS.map((c) => (row[c] === undefined ? null : typeof row[c] === 'object' && row[c] !== null ? JSON.stringify(row[c]) : row[c])));
  }
  return db;
}
const head = (title, extra = '') => `<head><title>${title}</title><meta name="description" content="About ${title}."><meta property="og:site_name" content="Acme"><meta property="og:image" content="https://x.com/i.png">${extra}</head>`;
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const post = (n) => `<html>${head(`Post ${n}`)}<body><main><article><header class="post-head"><h1>Post ${n}</h1><time datetime="2026-0${n}-01">${n} Jan</time><span class="byline">By Ann</span></header><p>Text.</p></article></main></body></html>`;

test('plan: each field present and valid, wrong, shown on the page (and where), or to supply', () => {
  const db = crawlOf([
    ['https://x.com/', `<html>${head('Acme', ld({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Acme', url: 'https://x.com/' }))}<body><main><h1>We make anvils</h1></main></body></html>`, 9],
    ['https://x.com/blog', `<html>${head('Blog')}<body><main><h1>Blog</h1></main></body></html>`],
    ...[1, 2, 3].map((n) => [`https://x.com/blog/post-${n}`, post(n)]),
    ['https://x.com/privacy', `<html>${head('Privacy')}<body><main><h1>Privacy</h1></main></body></html>`],
  ]);
  const plan = schemaPlan(db);
  const by = Object.fromEntries(plan.templates.map((t) => [t.shape, t]));
  assert.equal(plan.identity_type, 'Organization');

  const blog = by['/blog/*'];
  assert.equal(blog.role, 'article');
  assert.deepEqual(blog.types.map((t) => [t.type, t.on_samples]), [['BlogPosting', '0 of 3'], ['BreadcrumbList', '0 of 3']]);
  const f = Object.fromEntries(blog.types[0].fields.map((x) => [x.key, x]));
  assert.equal(f.headline.state, 'on_page');
  assert.equal(f.headline.where, 'h1');
  assert.equal(f.datePublished.where, 'header.post-head>time');
  assert.equal(f['author.name'].where, 'header.post-head>span.byline');
  assert.equal(f['author.url'].state, 'missing');

  // The home page: WebSite valid; Organization named by the site's name, not by its H1 tagline.
  const home = by['/'];
  const org = home.types.find((t) => t.type === 'Organization').fields.find((x) => x.key === 'name');
  assert.deepEqual([org.state, org.where], ['on_page', 'meta[property=og:site_name]']);
  assert.equal(home.types.find((t) => t.type === 'WebSite').fields.find((x) => x.key === 'name').state, 'valid');

  // A top-level legal page has nothing to add; the blog index is a listing.
  assert.deepEqual([by['/privacy'].role, by['/privacy'].types, by['/privacy'].todo], ['legal', [], 0]);
  assert.equal(by['/blog'].role, 'listing');
  // The template with the most to gain comes first.
  assert.equal(plan.templates[0].shape, '/blog/*');
});

test('plan: a wrong value is reported with its reason, and WebSite off the home page is to remove', () => {
  const bad = (n) => `<html>${head(`Post ${n}`, ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'BlogPosting', headline: `Post ${n}`, datePublished: 'last week' }, { '@type': 'WebSite', name: 'Acme', url: 'https://x.com/' }] }))}<body><main><h1>Post ${n}</h1></main></body></html>`;
  const plan = schemaPlan(crawlOf([1, 2].map((n) => [`https://x.com/blog/p${n}`, bad(n)])));
  const t = plan.templates[0];
  const date = t.types[0].fields.find((x) => x.key === 'datePublished');
  assert.deepEqual([date.state, date.why], ['wrong', 'datetime']);
  assert.deepEqual(t.remove, ['WebSite: Google reads it on the home page only']);
});

test('plan: a SaaS pricing page carries the product once, WebApplication unless there is an app to install', () => {
  const pricing = `<html>${head('Pricing')}<body><main><h1>Pricing</h1><div class="plan"><b class="price">€19</b></div></main></body></html>`;
  const web = schemaPlan(crawlOf([['https://x.com/pricing', pricing]]));
  assert.equal(web.product_type, 'WebApplication');
  const p = web.templates.find((t) => t.shape === '/pricing');
  assert.deepEqual([p.role, p.types.map((t) => t.type)], ['pricing', ['WebApplication']]);
  const f = Object.fromEntries(p.types[0].fields.map((x) => [x.key, x]));
  assert.deepEqual([f.name.state, f.name.where], ['on_page', 'meta[property=og:site_name]']);
  assert.deepEqual([f['offers.price'].state, f['offers.price'].where], ['on_page', 'main>div.plan>b.price']);
  assert.ok(f.applicationCategory && !f.isAccessibleForFree);

  const db = crawlOf([['https://x.com/pricing', pricing]]);
  db.prepare("INSERT INTO links (src, dst, type) VALUES ('https://x.com/pricing', 'https://apps.apple.com/app/x/id1', 'hyperlink')").run();
  assert.equal(schemaPlan(db).templates[0].types[0].type, 'SoftwareApplication');
});

test('plan: a model settles an open template; a template the rules place keeps its role', () => {
  const feature = (n) => `<html>${head(`Feature ${n}`)}<body><main><h1>Feature ${n}</h1><p>What it does.</p></main></body></html>`;
  const db = crawlOf([
    ['https://x.com/', `<html>${head('Acme')}<body><main><h1>Acme</h1></main></body></html>`, 9],
    ...[1, 2].map((n) => [`https://x.com/features/f-${n}`, feature(n)]),
    ...[1, 2].map((n) => [`https://x.com/blog/post-${n}`, post(n)]),
  ]);
  const open = schemaPlan(db).templates.find((t) => t.shape === '/features/*');
  assert.equal(open.decided, 'open');
  const plan = schemaPlan(db, { roles: { '/features/*': 'service', '/blog/*': 'legal', '/': 'nonsense' } });
  const by = Object.fromEntries(plan.templates.map((t) => [t.shape, t]));
  assert.deepEqual([by['/features/*'].role, by['/features/*'].decided], ['service', 'model']);
  assert.deepEqual(by['/features/*'].types.map((t) => t.type), ['Service', 'BreadcrumbList']);
  assert.equal(by['/blog/*'].role, 'article');
  assert.equal(by['/'].role, 'home');
});
