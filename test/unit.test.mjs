import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { parseRobots, robotsAllows } from '../lib/robots.mjs';
import { extract, simhash, hamming, pixelWidth } from '../lib/extract.mjs';
import { signServiceAccountJwt } from '../lib/google.mjs';

test('robots.txt: a named group wins over *, and the longest rule wins inside a group', () => {
  const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/open\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: https://example.com/s.xml');
  assert.equal(robotsAllows(r, '/private/x', 'SiteAuditCrawler'), false);
  assert.equal(robotsAllows(r, '/private/open/page', 'SiteAuditCrawler'), true);
  assert.equal(robotsAllows(r, '/anything', 'SiteAuditCrawler'), true);
  assert.equal(robotsAllows(r, '/anything', 'GPTBot'), false);
  assert.deepEqual(r.sitemaps, ['https://example.com/s.xml']);
});

test('robots.txt: the crawler is matched on its token, not on words of its URL', () => {
  // A group named after a word of the default user-agent URL ("github") must not apply to it.
  const r = parseRobots('User-agent: github\nDisallow: /\n');
  assert.equal(robotsAllows(r, '/', 'SiteAuditCrawler'), true);
});

test('extract: head, headings, links with their position, and the main text without navigation', () => {
  const html = `<html lang="en"><head><title>Hello world</title><meta name="description" content="A page.">
<link rel="canonical" href="/hello"><link rel="alternate" hreflang="fr" href="/fr/hello"></head>
<body><nav><a href="/">Home</a></nav><main><h1>Hello</h1><h3>Skipped a level</h3><p>Some words here.</p>
<a href="/a">Read the guide</a><a href="javascript:void(0)">x</a><a href="/b"></a><img src="/i.png"></main>
<footer><a href="/legal">Legal</a></footer></body></html>`;
  const { page, links, text } = extract(html, 'https://example.com/hello');
  assert.equal(page.title, 'Hello world');
  assert.equal(page.canonical, 'https://example.com/hello');
  assert.equal(page.canonical_relative, 1);
  assert.equal(page.h1_count, 1);
  assert.equal(page.heading_order_ok, 0);
  assert.equal(page.uncrawlable_links, 1);
  assert.equal(page.empty_anchors, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(page.hreflang)), [{ lang: 'fr', href: 'https://example.com/fr/hello' }]);
  const a = links.find((l) => l.dst === 'https://example.com/a');
  assert.equal(a.position, 'content');
  assert.equal(a.anchor, 'Read the guide');
  assert.equal(links.find((l) => l.dst === 'https://example.com/legal').position, 'footer');
  assert.equal(links.find((l) => l.type === 'image').has_alt, 0);
  assert.ok(!text.includes('Legal') && !text.includes('Home'), 'navigation and footer are not content');
});

test('simhash: near texts are close, different texts are far', () => {
  const base = 'the quick brown fox jumps over the lazy dog and keeps running across the wide green field until night falls'.split(' ');
  const near = [...base];
  near[5] = 'under';
  const far = 'invoices are due thirty days after the end of the month in which the goods were delivered to the customer'.split(' ');
  assert.ok(hamming(simhash(base), simhash(near)) < hamming(simhash(base), simhash(far)));
  assert.equal(simhash(['two', 'words']), null);
});

test('pixelWidth: wide letters weigh more than narrow ones', () => {
  assert.ok(pixelWidth('WWWW') > pixelWidth('iiii'));
  assert.equal(pixelWidth(''), 0);
});

test('Google service account: the JWT is RS256-signed with the key and asks for the read-only scope', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'audit@project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' };
  const jwt = signServiceAccountJwt(sa, { now: 1000 });
  const [h, c, sig] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(JSON.parse(Buffer.from(h, 'base64url').toString()).alg, 'RS256');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/webmasters.readonly');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url')));
});
