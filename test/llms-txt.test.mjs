import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { extract } from '../lib/extract.mjs';
import { SCHEMA, PAGE_COLUMNS } from '../lib/schema.mjs';
import { checkLlmsTxt, draftLlmsTxt, parseLlmsTxt } from '../lib/llms-txt.mjs';

function crawlOf(pages) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const insert = db.prepare(`INSERT INTO pages (${PAGE_COLUMNS.join(',')}) VALUES (${PAGE_COLUMNS.map(() => '?').join(',')})`);
  for (const [url, html, over = {}] of pages) {
    const row = { url, internal: 1, type: 'html', status: 200, indexable: 1, link_score: 1, ...(html ? extract(html, url).page : {}), ...over };
    insert.run(...PAGE_COLUMNS.map((c) => (row[c] === undefined ? null : typeof row[c] === 'object' && row[c] !== null ? JSON.stringify(row[c]) : row[c])));
  }
  return db;
}
const page = (title, desc, extra = '') => `<html lang="en"><head><title>${title} | Acme</title><meta name="description" content="${desc}"><meta property="og:site_name" content="Acme">${extra}</head><body><main><h1>${title}</h1><p>Text.</p></main></body></html>`;

const site = () =>
  crawlOf([
    ['https://acme.com/', page('Acme', 'Anvils that never crack, made to order.'), { link_score: 10 }],
    ['https://acme.com/pricing', page('Pricing', 'Three plans, from 9 euros a month.', '<link rel="alternate" type="text/markdown" href="/pricing.md">'), { link_score: 8 }],
    ['https://acme.com/blog', page('Blog', 'All our posts.')],
    ['https://acme.com/blog/forging', page('How we forge', 'The four steps of a forged anvil.'), { link_score: 3 }],
    ['https://acme.com/blog/steel', page('Which steel', 'Tool steel against cast iron.'), { link_score: 2 }],
    ['https://acme.com/privacy', page('Privacy', 'What we keep and why.')],
    ['https://acme.com/fr/tarifs', page('Tarifs', 'Trois offres.').replace('lang="en"', 'lang="fr"')],
    ['https://acme.com/old', page('Old', 'Gone.'), { status: 301, redirect_to: 'https://acme.com/pricing' }],
    ['https://acme.com/hidden', page('Hidden', 'Not for search.'), { indexable: 0, indexability: 'noindex' }],
  ]);

test('draft: name, summary from the home page, sections by role, Markdown copies, legal pages optional', () => {
  const d = draftLlmsTxt(site());
  assert.equal(d.name, 'Acme');
  assert.equal(d.lang, 'en');
  assert.equal(d.other_lang_pages, 1);
  assert.deepEqual(d.sections.map((s) => s.name), ['Product', 'Articles', 'Optional']);
  assert.match(d.text, /^# Acme\n\n> Anvils that never crack, made to order\.\n\n## Product\n\n- \[Pricing\]\(https:\/\/acme\.com\/pricing\.md\): Three plans, from 9 euros a month\./);
  assert.match(d.text, /## Articles\n\n- \[How we forge\]\(https:\/\/acme\.com\/blog\/forging\): The four steps/);
  assert.match(d.text, /## Optional\n\n(- .*\n)*- \[Privacy\]\(https:\/\/acme\.com\/privacy\)/);
  assert.ok(!/hidden|\/old|tarifs/.test(d.text), 'a redirect, a noindex page and another language stay out');
  assert.equal(d.markdown_links, 1);
  // The draft reads back without a problem.
  assert.deepEqual(parseLlmsTxt(d.text).problems, []);
});

test('parse: only the H1 is required; a web page, a missing title and bare list items are named', () => {
  assert.deepEqual(parseLlmsTxt('# Acme\n').problems.map((p) => p.code), ['no_links']);
  assert.deepEqual(parseLlmsTxt('<!doctype html><html></html>').problems.map((p) => p.code), ['html']);
  const p = parseLlmsTxt('> summary first\n\n## Docs\n- the docs\n- [API](/api): reference\n# Again');
  assert.deepEqual(p.problems.map((x) => x.code), ['no_title', 'item_without_link', 'relative_link', 'several_titles']);
  const ok = parseLlmsTxt('# Acme\n\n> Anvils.\n\nSome details.\n\n## Optional\n- [Privacy](https://acme.com/privacy)');
  assert.equal(ok.summary, 'Anvils.');
  assert.deepEqual(ok.links.map((l) => [l.url, l.optional, l.note]), [['https://acme.com/privacy', true, null]]);
});

test('check: every link against the crawl, and the pages that matter left out', () => {
  const file = [
    '# Acme',
    '## Pages',
    '- [Pricing](https://acme.com/pricing.md): plans',
    '- [Old](https://acme.com/old)',
    '- [Hidden](https://acme.com/hidden)',
    '- [New](https://acme.com/new)',
    '- [Partner](https://partner.com/)',
    '- [Forging](https://acme.com/blog/forging/)',
    '- [Steel](https://acme.com/blog/steel.md)',
  ].join('\n');
  const c = checkLlmsTxt(site(), file);
  assert.deepEqual(c.links.map((l) => [l.title, l.verdict]), [
    ['Pricing', 'markdown'],
    ['Old', 'redirect'],
    ['Hidden', 'noindex'],
    ['New', 'not_crawled'],
    ['Partner', 'external'],
    ['Forging', 'ok'],
    ['Steel', 'not_crawled'],
  ]);
  // steel.md is the convention's copy of /blog/steel: listed, to be fetched. Nothing that matters is left out.
  assert.equal(c.links.at(-1).page, 'https://acme.com/blog/steel');
  assert.deepEqual(c.missing, []);
});

test('draft: a section of several big templates is split by template, each capped', () => {
  const db = crawlOf([
    ['https://acme.com/', page('Acme', 'Anvils.'), { link_score: 10 }],
    ...Array.from({ length: 20 }, (_, i) => [`https://acme.com/guides/g-${i}`, page(`Guide ${i}`, `Guide number ${i}.`), { link_score: 20 - i }]),
    ...[1, 2, 3].map((i) => [`https://acme.com/blog/p-${i}`, page(`Post ${i}`, `Post number ${i}.`)]),
    ['https://acme.com/news/one', page('One news', 'A single news item.')],
  ]);
  const d = draftLlmsTxt(db);
  assert.deepEqual(d.sections.map((s) => [s.name, s.links.length]), [['Guides', 15], ['Blog', 3], ['Articles', 1]]);
  assert.equal(d.sections[0].links[0].title, 'Guide 0', 'the most linked first');
});
