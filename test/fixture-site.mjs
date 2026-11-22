// A small website with planted defects, served on localhost. Each page exists to trigger (or, for
// the clean ones, not trigger) specific controls; the comment on each route names them.
// External links point at 127.0.0.1: same server, but another host name, so the crawler treats them
// as external.
import { createServer } from 'node:http';

// Deterministic filler text, different for every seed, so that only the pages meant to be duplicates are.
const VOCABULARY = 'widget gear spring lever bolt panel frame motor cable sensor valve pump filter switch handle hinge bracket coil gasket rotor shaft bearing clamp nozzle socket plate rail wheel belt chain drum blade dial knob latch pin rivet screw washer nut spindle'.split(' ');
function words(n, seed = 'widgets') {
  let x = [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const out = [];
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out.push(VOCABULARY[x % VOCABULARY.length]);
  }
  return out.join(' ');
}

function page({ title, description, h1, body = '', head = '', lang = 'en' }) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${title === undefined ? '' : `<title>${title}</title>`}
${description ? `<meta name="description" content="${description}">` : ''}
${head}</head><body><nav><a href="/">Home</a> <a href="/about">About</a></nav><main>${h1 ? `<h1>${h1}</h1>` : ''}${body}</main><footer><a href="/team">Team</a></footer></body></html>`;
}

export function fixtureRoutes(origin, externalOrigin) {
  const html = (body) => ({ status: 200, type: 'text/html; charset=utf-8', body });
  const redirect = (status, location) => ({ status, headers: { location } });
  const sameDescription = 'A fixture page about widgets, used to test the site audit crawler end to end.';
  return {
    '/robots.txt': { status: 200, type: 'text/plain', body: `User-agent: *\nDisallow: /private\n\n# ai_bots_blocked\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: ${origin}/sitemap.xml\n` },
    // sitemap_non_indexable (/noindex-page), sitemap_orphan (/orphan), sitemap_no_lastmod (one URL without)
    '/sitemap.xml': { status: 200, type: 'application/xml', body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${origin}/</loc><lastmod>2026-01-01</lastmod></url>
<url><loc>${origin}/about</loc><lastmod>2026-01-01</lastmod></url>
<url><loc>${origin}/noindex-page</loc><lastmod>2026-01-01</lastmod></url>
<url><loc>${origin}/orphan</loc></url>
</urlset>` },
    // The clean reference page: none of the page-level issues should fire on it.
    '/': html(page({
      title: 'Fixture widgets: the home of the test site',
      description: sameDescription,
      h1: 'Fixture widgets',
      head: `<link rel="canonical" href="${origin}/"><meta property="og:title" content="Fixture"><meta property="og:type" content="website"><meta property="og:url" content="${origin}/"><meta property="og:image" content="${origin}/img/og.png">`,
      body: `<h2>What this is</h2><p>${words(260)}</p>
<a href="/about">About the widgets</a> <a href="/blog/post-1">The 2019 guide</a> <a href="/missing">A broken link</a>
<a href="/old-page">An old page</a> <a href="/temp">A temporary page</a> <a href="/loop-a">A loop</a>
<a href="/noindex-page">Hidden</a> <a href="/canonicalised">Copy</a> <a href="/en/">English</a> <a href="/fr/">French</a>
<a href="/dup-a">Duplicate A</a> <a href="/dup-b">Duplicate B</a> <a href="/private/secret">Private</a>
<a href="${externalOrigin}/gone">An outside source</a> <img src="/img/big.png">`,
    })),
    // title_duplicate with /team, description_missing, h1_missing, content_lorem
    '/about': html(page({ title: 'About us', h1: undefined, body: `<p>Lorem ipsum dolor sit amet. ${words(220)}</p><a href="/team">The team</a>` })),
    '/team': html(page({ title: 'About us', description: 'The people behind the fixture widgets, their roles and how to reach them.', h1: 'The team', body: `<p>${words(230, 'team')}</p>` })),
    // directive_noindex, and sitemap_non_indexable through the sitemap
    '/noindex-page': html(page({ title: 'A page kept out of search', description: sameDescription, h1: 'Hidden', head: '<meta name="robots" content="noindex">', body: `<p>${words(220, 'hidden')}</p>` })),
    // canonical_canonicalised
    '/canonicalised': html(page({ title: 'A copy that points elsewhere', description: sameDescription, h1: 'Copy', head: `<link rel="canonical" href="${origin}/about">`, body: `<p>${words(220, 'copy')}</p>` })),
    // content_stale_year, schema_rich_result_warnings (Article without datePublished),
    // geo_no_cited_source and geo_few_statistics (an article of 500+ words, no outside link, no figure)
    '/blog/post-1': html(page({
      title: 'The 2019 guide to widgets',
      description: 'How to choose, set up and maintain widgets, step by step, for a small team.',
      h1: 'The 2019 guide to widgets',
      head: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"The 2019 guide to widgets","image":"${origin}/img/og.png","author":{"@type":"Person","name":"A. Writer"}}</script>`,
      body: `<p>${words(560, 'guide')}</p><a href="/">Back home</a>`,
    })),
    // hreflang_no_return: /en/ lists /fr/, and /fr/ does not list /en/ back; title_repeated_segment (the site name twice)
    '/en/': html(page({ title: 'Widgets in English | Fixture widgets | Fixture widgets', description: 'The English version of the fixture widgets page, with its French twin.', h1: 'English', head: `<link rel="alternate" hreflang="en" href="${origin}/en/"><link rel="alternate" hreflang="fr" href="${origin}/fr/"><link rel="alternate" hreflang="x-default" href="${origin}/en/">`, body: `<p>${words(220, 'english')}</p>` })),
    // hreflang_missing_x_default
    '/fr/': html(page({ title: 'Widgets en français', description: 'La version française de la page des widgets de test, avec son lien.', h1: 'Français', lang: 'fr', head: `<link rel="alternate" hreflang="fr" href="${origin}/fr/">`, body: `<p>${words(220, 'francais')}</p>` })),
    // content_exact_duplicate
    '/dup-a': html(page({ title: 'Duplicate A', description: 'First of two pages with the same body text, to test exact duplicates.', h1: 'Same', body: `<p>${words(240, 'same')}</p>` })),
    '/dup-b': html(page({ title: 'Duplicate B', description: 'Second of two pages with the same body text, to test exact duplicates.', h1: 'Same', body: `<p>${words(240, 'same')}</p>` })),
    // sitemap_orphan: only the sitemap knows it
    '/orphan': html(page({ title: 'A page no link reaches', description: 'An orphan: it is in the sitemap, and no page of the site links to it.', h1: 'Orphan', body: `<p>${words(220, 'orphan')}</p>` })),
    // redirect_chain (301 then 302), internal_3xx, and redirect_temporary on the 302
    '/old-page': redirect(301, '/older-page'),
    '/older-page': redirect(302, '/about'),
    // redirect_temporary
    '/temp': redirect(307, '/team'),
    // redirect_loop
    '/loop-a': redirect(301, '/loop-b'),
    '/loop-b': redirect(301, '/loop-a'),
    // For the Search Console test: an old URL that redirects, and nothing at /gone-page (404).
    '/old-url': redirect(301, '/about'),
    // image_over_100kb, image_legacy_format, image_missing_alt_attribute (on the home page)
    '/img/big.png': { status: 200, type: 'image/png', body: Buffer.alloc(120 * 1024, 1) },
    '/img/og.png': { status: 200, type: 'image/png', body: Buffer.alloc(2 * 1024, 1) },
  };
}

/** Start the site. Returns { origin, externalOrigin, close }. */
export async function startFixtureSite({ port = 0 } = {}) {
  let routes = {};
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    // External links arrive with Host 127.0.0.1: nothing lives there.
    const r = req.headers.host?.startsWith('127.0.0.1') ? null : routes[path];
    if (!r) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Not found</title><h1>Not found</h1>');
      return;
    }
    res.writeHead(r.status, { ...(r.type ? { 'content-type': r.type } : {}), ...(r.headers ?? {}), 'strict-transport-security': 'max-age=1' });
    res.end(req.method === 'HEAD' ? undefined : r.body);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address().port;
  const origin = `http://localhost:${actual}`;
  const externalOrigin = `http://127.0.0.1:${actual}`;
  routes = fixtureRoutes(origin, externalOrigin);
  return { origin, externalOrigin, close: () => new Promise((r) => server.close(r)) };
}
