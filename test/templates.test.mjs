import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { extract } from '../lib/extract.mjs';
import { SCHEMA, PAGE_COLUMNS, upgradeSchema } from '../lib/schema.mjs';
import { pathShape, templatesOf } from '../lib/templates.mjs';

const product = (name, id, price) => `<html><head><title>${name}</title>
<meta property="product:price:amount" content="${price}"><meta name="author" content="Ann"><meta name="keywords" content="x"></head>
<body><nav class="breadcrumb"><a href="/">Home</a><a href="/shop">Shop</a><span>${name}</span></nav>
<main><article class="post-${id}"><h1>${name}</h1><time datetime="2026-01-02">2 Jan</time><span class="byline">By Ann</span>
<div class="price-box"><span class="amount">€${price}</span></div><p>In stock from 3 warehouses.</p>
<address>1 Main St, Berlin</address><a href="tel:+4930123">Call</a></article></main></body></html>`;
const post = (title) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>Text about ${title}.</p></main></body></html>`;

test('evidence: each field with the element that shows it, the same path on every page of a template', () => {
  const a = extract(product('Blue kettle', 12, '19,99'), 'https://x.com/shop/blue');
  const b = extract(product('Red kettle', 456, '24,50'), 'https://x.com/shop/red');
  const ev = JSON.parse(a.page.field_evidence);
  assert.deepEqual(ev.meta, { 'product:price:amount': '19,99', author: 'Ann' });
  assert.deepEqual(ev.times, [{ path: 'article.post>time', value: '2026-01-02', text: '2 Jan' }]);
  assert.deepEqual(ev.prices, [{ path: 'article.post>div.price-box>span.amount', value: '€19,99' }]);
  assert.deepEqual(ev.addresses, [{ path: 'article.post>address', value: '1 Main St, Berlin' }]);
  assert.deepEqual(ev.phones, [{ path: 'article.post>a', value: '+4930123' }]);
  assert.deepEqual(ev.authors, [{ path: 'article.post>span.byline', value: 'By Ann' }]);
  assert.deepEqual(ev.breadcrumb, { path: 'nav.breadcrumb', items: ['Home', 'Shop', 'Blue kettle'] });
  assert.equal(JSON.parse(b.page.field_evidence).prices[0].path, ev.prices[0].path);
  // Same layout, other name, id and price: same signature. Another layout: another one.
  assert.equal(a.page.struct_sig, b.page.struct_sig);
  assert.notEqual(a.page.struct_sig, extract(post('Widgets'), 'https://x.com/blog/w').page.struct_sig);
  assert.equal(a.page.text_cut, 0);
});

test('evidence: a page without any field stores nothing, and "3 warehouses" is not a price', () => {
  const { page } = extract(post('Widgets'), 'https://x.com/blog/w');
  assert.equal(page.field_evidence, null);
  assert.equal(JSON.parse(extract(product('K', 1, '5'), 'https://x.com/s/k').page.field_evidence).prices.length, 1);
});

test('evidence stays under 6,000 characters, dropping whole lists', () => {
  const html = `<html><body><main><h1>A</h1>${Array.from({ length: 200 }, (_, i) => `<address>${'Street '.repeat(30)}${i}</address>`).join('')}</main></body></html>`;
  const { page } = extract(html, 'https://x.com/a');
  assert.ok(page.field_evidence.length <= 6000);
});

test('path shape: the first segment kept, the rest as *, the page\'s own language dropped', () => {
  assert.equal(pathShape('https://x.com/'), '/');
  assert.equal(pathShape('https://x.com/about'), '/about');
  assert.equal(pathShape('https://x.com/blog/2024/my-post?x=1'), '/blog/*/*');
  assert.equal(pathShape('https://x.com/fr/blog/mon-article', 'fr'), '/blog/*');
  assert.equal(pathShape('https://x.com/fr', 'fr-FR'), '/');
  assert.equal(pathShape('https://x.com/vs/notion', 'en'), '/vs/*');
  assert.equal(pathShape('https://x.com/fr/blog/x', 'en'), '/fr/*/*');
});

test('templates: one per path shape and layout, biggest first, with samples and field counts', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const insert = db.prepare(`INSERT INTO pages (${PAGE_COLUMNS.join(',')}) VALUES (${PAGE_COLUMNS.map(() => '?').join(',')})`);
  const add = (url, html, linkScore) => {
    const row = { url, internal: 1, type: 'html', status: 200, ...extract(html, url).page, link_score: linkScore };
    insert.run(...PAGE_COLUMNS.map((c) => (row[c] === undefined ? null : typeof row[c] === 'object' && row[c] !== null ? JSON.stringify(row[c]) : row[c])));
  };
  ['a', 'b', 'c', 'd'].forEach((n, i) => add(`https://x.com/shop/${n}`, product(n, i, '9'), i));
  add('https://x.com/shop/sale', post('Sale'), 9);
  add('https://x.com/blog/one', post('One'), 1);
  const t = templatesOf(db, { samples: 2 });
  assert.deepEqual(t.map((x) => [x.shape, x.pages]), [['/shop/*', 4], ['/blog/*', 1], ['/shop/*', 1]]);
  assert.deepEqual(t[0].samples, ['https://x.com/shop/d', 'https://x.com/shop/c']);
  assert.deepEqual(t[0].fields, { times: 4, prices: 4, addresses: 4, authors: 4, phones: 4, breadcrumb: 4 });
  assert.equal(t[1].struct_sig, t[2].struct_sig);
});

test('upgradeSchema: a crawl made before these columns gets them, its rows kept, then takes new writes', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA.replace('  struct_sig TEXT, field_evidence TEXT, text_cut INTEGER,\n', ''));
  db.prepare('INSERT INTO pages (url, title) VALUES (?, ?)').run('https://x.com/', 'Home');
  assert.deepEqual(upgradeSchema(db), ['struct_sig', 'field_evidence', 'text_cut']);
  assert.deepEqual(upgradeSchema(db), []);
  db.prepare(`INSERT OR REPLACE INTO pages (${PAGE_COLUMNS.join(',')}) VALUES (${PAGE_COLUMNS.map(() => '?').join(',')})`).run(...PAGE_COLUMNS.map((c) => (c === 'url' ? 'https://x.com/a' : null)));
  assert.equal(db.prepare('SELECT count(*) AS n FROM pages').get().n, 2);
});
