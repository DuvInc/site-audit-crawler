// Everything read from one HTML document. Used on the raw response (crawl.mjs)
// and on the DOM after JavaScript ran (render.mjs), so both sides compare like for like.
import { load } from 'cheerio';
import { createHash } from 'node:crypto';

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

function fnv(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 64-bit simhash over 3-word shingles, as 16 hex chars. Two near-identical texts
// differ by a few bits only.
export function simhash(words) {
  if (words.length < 3) return null;
  const v = new Int32Array(64);
  for (let i = 0; i + 2 < words.length; i++) {
    const s = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    const a = fnv(s, 2166136261);
    const b = fnv(s, 0x9747b28c);
    for (let k = 0; k < 32; k++) {
      v[k] += (a >>> k) & 1 ? 1 : -1;
      v[32 + k] += (b >>> k) & 1 ? 1 : -1;
    }
  }
  let lo = 0;
  let hi = 0;
  for (let k = 0; k < 32; k++) {
    if (v[k] > 0) lo |= 1 << k;
    if (v[32 + k] > 0) hi |= 1 << k;
  }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

export function hamming(a, b) {
  let d = 0;
  for (const [x, y] of [[a.slice(0, 8), b.slice(0, 8)], [a.slice(8), b.slice(8)]]) {
    let n = (parseInt(x, 16) ^ parseInt(y, 16)) >>> 0;
    while (n) {
      n &= n - 1;
      d++;
    }
  }
  return d;
}

// Rough width of a string in Google's result title font (Arial 20 px). Good to about 5 %.
export function pixelWidth(str) {
  let w = 0;
  for (const c of str) {
    if (" .,:;|!'ijlI".includes(c)) w += 5.6;
    else if ('ftr()[]-"/'.includes(c)) w += 6.9;
    else if ('mwMW@%'.includes(c)) w += 17.2;
    else if (c >= 'A' && c <= 'Z') w += 13.6;
    else w += 11.1;
  }
  return Math.round(w);
}

export function extract(html, pageUrl) {
  const $ = load(html);
  const baseHref = $('base[href]').attr('href');
  let base = pageUrl;
  try {
    if (baseHref) base = new URL(baseHref, pageUrl).href;
  } catch {}
  const abs = (href) => {
    try {
      const u = new URL(href.trim(), base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      u.hash = '';
      return u.href;
    } catch {
      return null;
    }
  };
  const position = (el) => {
    const p = $(el).closest('nav,header,footer,aside').get(0);
    return p ? p.tagName.toLowerCase() : 'content';
  };

  const links = [];
  const p = {};

  // Head
  const titlesHead = $('head title');
  const titlesBody = $('body title').filter((_, el) => $(el).closest('svg').length === 0);
  p.title = clean(titlesHead.first().text()) || clean(titlesBody.first().text()) || null;
  p.title_count = titlesHead.length + titlesBody.length;
  p.title_len = p.title ? p.title.length : 0;
  p.title_outside_head = titlesBody.length > 0 ? 1 : 0;
  p.title_px = p.title ? pixelWidth(p.title) : 0;
  const md = $('link[rel="alternate" i][type="text/markdown" i]').attr('href');
  p.md_alternate = md ? abs(md) : null;

  const descs = $('meta[name="description" i]');
  p.description = clean(descs.first().attr('content')) || null;
  p.description_count = descs.length;
  p.description_len = p.description ? p.description.length : 0;

  p.meta_robots = $('meta[name="robots" i]').map((_, el) => clean($(el).attr('content')).toLowerCase()).get().join(', ') || null;
  p.meta_refresh = clean($('meta[http-equiv="refresh" i]').attr('content')) || null;
  p.viewport = clean($('meta[name="viewport" i]').attr('content')) || null;
  p.charset = $('meta[charset]').attr('charset') || null;
  p.lang = $('html').attr('lang') || null;

  const canon = $('link[rel="canonical" i]');
  const canonRaw = canon.first().attr('href');
  p.canonical = canonRaw ? abs(canonRaw) : null;
  p.canonical_count = canon.length;
  p.canonical_relative = canonRaw && !/^https?:\/\//i.test(canonRaw.trim()) ? 1 : 0;
  p.canonical_outside_head = $('body link[rel="canonical" i]').length > 0 ? 1 : 0;
  p.rel_next = $('link[rel="next" i]').attr('href') ? abs($('link[rel="next" i]').attr('href')) : null;
  p.rel_prev = $('link[rel="prev" i]').attr('href') ? abs($('link[rel="prev" i]').attr('href')) : null;

  p.hreflang = $('link[rel="alternate" i][hreflang]')
    .map((_, el) => ({ lang: $(el).attr('hreflang'), href: abs($(el).attr('href') ?? '') }))
    .get();
  if (!p.hreflang.length) p.hreflang = null;

  const og = {};
  $('meta[property^="og:"]').each((_, el) => {
    og[$(el).attr('property')] ??= $(el).attr('content') ?? '';
  });
  p.og = Object.keys(og).length ? og : null;
  const tw = {};
  $('meta[name^="twitter:"], meta[property^="twitter:"]').each((_, el) => {
    tw[$(el).attr('name') ?? $(el).attr('property')] ??= $(el).attr('content') ?? '';
  });
  p.twitter = Object.keys(tw).length ? tw : null;
  if (og['og:image'] && abs(og['og:image'])) links.push({ dst: abs(og['og:image']), type: 'og-image', position: 'head' });

  // Structured data
  const types = new Set();
  const formats = new Set();
  let parseErrors = 0;
  const blocks = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node['@type']) [].concat(node['@type']).forEach((t) => types.add(String(t)));
    for (const v of Object.values(node)) walk(v);
  };
  $('script[type="application/ld+json" i]').each((_, el) => {
    formats.add('json-ld');
    try {
      const parsed = JSON.parse($(el).text());
      blocks.push(parsed);
      walk(parsed);
    } catch {
      parseErrors++;
    }
  });
  $('[itemtype]').each((_, el) => {
    formats.add('microdata');
    types.add(($(el).attr('itemtype') ?? '').split('/').pop());
  });
  if ($('[typeof]').length) formats.add('rdfa');
  p.schema_types = types.size ? [...types] : null;
  p.schema_formats = formats.size ? [...formats].join(',') : null;
  p.schema_parse_errors = parseErrors;
  const schemaJson = JSON.stringify(blocks);
  p.schema_json = blocks.length && schemaJson.length < 60000 ? schemaJson : null;

  // Headings
  const h1s = $('h1').map((_, el) => clean($(el).text())).get();
  const h2s = $('h2').map((_, el) => clean($(el).text())).get();
  p.h1 = h1s[0] || null;
  p.h1_count = h1s.length;
  p.h1_len = p.h1 ? p.h1.length : 0;
  p.h2 = h2s[0] || null;
  p.h2_count = h2s.length;
  let prev = 0;
  let ordered = 1;
  $('h1,h2,h3,h4,h5,h6').each((i, el) => {
    const level = Number(el.tagName[1]);
    if ((i === 0 && level !== 1) || level > prev + 1) ordered = 0;
    prev = level;
  });
  p.heading_order_ok = ordered;

  // Links
  let emptyAnchors = 0;
  let uncrawlable = 0;
  let unsafeBlank = 0;
  $('a').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href');
    if (href === undefined || href.trim() === '') {
      if ($a.attr('onclick') !== undefined || href === '') uncrawlable++;
      return;
    }
    if (/^\s*javascript:/i.test(href)) {
      uncrawlable++;
      return;
    }
    if (/^\s*(mailto:|tel:|sms:|data:|#)/i.test(href)) return;
    const dst = abs(href);
    if (!dst) return;
    const alt = clean($a.find('img[alt]').first().attr('alt'));
    const anchor = clean($a.text());
    const rel = clean($a.attr('rel')).toLowerCase();
    if (!anchor && !alt && !clean($a.attr('aria-label')) && !clean($a.attr('title'))) emptyAnchors++;
    if ($a.attr('target') === '_blank' && !/noopener|noreferrer/.test(rel)) unsafeBlank++;
    links.push({
      dst,
      type: 'hyperlink',
      anchor: anchor || null,
      alt: alt || null,
      rel: rel || null,
      nofollow: /\bnofollow\b/.test(rel) ? 1 : 0,
      position: position(el),
      target: $a.attr('target') ?? null,
    });
  });
  p.empty_anchors = emptyAnchors;
  p.uncrawlable_links = uncrawlable;
  p.unsafe_blank_links = unsafeBlank;

  let imgCount = 0;
  $('img').each((_, el) => {
    const $i = $(el);
    const src = $i.attr('src');
    if (!src || /^\s*data:/i.test(src)) return;
    const dst = abs(src);
    if (!dst) return;
    imgCount++;
    const alt = $i.attr('alt');
    links.push({
      dst,
      type: 'image',
      alt: alt === undefined ? null : clean(alt),
      has_alt: alt === undefined ? 0 : 1,
      dims: $i.attr('width') !== undefined && $i.attr('height') !== undefined ? 1 : 0,
      position: position(el),
    });
  });
  p.img_count = imgCount;
  $('link[rel~="stylesheet" i][href]').each((_, el) => {
    const dst = abs($(el).attr('href'));
    if (dst) links.push({ dst, type: 'css', position: 'head' });
  });
  $('script[src]').each((_, el) => {
    const dst = abs($(el).attr('src'));
    if (dst) links.push({ dst, type: 'js', position: 'head' });
  });
  $('iframe[src]').each((_, el) => {
    const dst = abs($(el).attr('src'));
    if (dst) links.push({ dst, type: 'iframe', position: position(el) });
  });
  if (p.canonical) links.push({ dst: p.canonical, type: 'canonical', position: 'head' });
  for (const h of p.hreflang ?? []) if (h.href) links.push({ dst: h.href, type: 'hreflang', anchor: h.lang, position: 'head' });

  const https = pageUrl.startsWith('https:');
  p.mixed_content = https && links.some((l) => ['image', 'css', 'js', 'iframe'].includes(l.type) && l.dst.startsWith('http:')) ? 1 : 0;
  p.insecure_forms = $('form[action^="http:" i]').length;

  // Text of the main content. Many crawlers count the body without nav and footer; this is stricter.
  p.dom_nodes = $('*').length;
  $('script,style,noscript,template,svg,iframe').remove();
  // Main content: <main> when the page has one, otherwise the body without its header, nav, aside and footer.
  let $root = $('main, [role="main"]').first();
  if ($root.length) $root.find('nav,footer,aside').remove();
  else {
    $root = $('body');
    $root.find('nav,footer,aside').remove();
    $root.children('header').remove();
  }
  const text = clean($root.text());
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  p.word_count = words.length;
  p.text_ratio = html.length ? Math.round((text.length / html.length) * 1000) / 10 : 0;
  p.text_hash = words.length ? createHash('sha1').update(words.join(' ')).digest('hex') : null;
  p.simhash = simhash(words);
  p.has_lorem = /lorem ipsum/i.test(text) ? 1 : 0;

  return { page: p, links, text: text.slice(0, 40000) };
}
