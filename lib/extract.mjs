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

// The structure of a page and the evidence of its fields, for structured data planned per template
// (a template is many pages of one layout). Bounded: a few items of each kind, a few kilobytes a page.
const EVIDENCE_MAX = 6000;
const META_KEEP = /^(author|publisher|copyright|date|last-modified|article:|product:|og:type$|og:site_name$|og:price|business:|place:|event:|book:|profile:|geo\.|dc\.|citation_)/i;
const PRICE = /(?:[$€£¥₹]\s?\d(?:[\d.,\u00a0 ]*\d)?|\d(?:[\d.,\u00a0 ]*\d)?\s?(?:€|eur|usd|gbp|chf|\$|£)(?![a-z]))/i;
const PRICE_TEXT_MAX = 40;

/**
 * Where an element sits, as a short CSS path from its landmark: tag names, with the first class of
 * each (digits dropped, so `post-123` and `post-456` read the same). The same template gives the same
 * path on every page, which is what lets one rule read a field across all of them.
 */
function pathOf($, el) {
  const parts = [];
  for (let node = el; node && node.type === 'tag' && parts.length < 6; node = node.parent) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    const cls = ($(node).attr('class') ?? '').trim().split(/\s+/)[0]?.replace(/\d+/g, '').replace(/[^\w-]/g, '').replace(/[-_]+$/, '').slice(0, 24);
    parts.unshift(cls ? `${tag}.${cls}` : tag);
    if (['main', 'article', 'header', 'footer', 'nav', 'aside'].includes(tag)) break;
  }
  return parts.join('>');
}

function evidenceOf($, html) {
  const ev = {};
  const meta = {};
  $('meta[name], meta[property], meta[itemprop]').each((_, el) => {
    const k = $(el).attr('property') ?? $(el).attr('name') ?? $(el).attr('itemprop');
    if (k && META_KEEP.test(k) && Object.keys(meta).length < 20) meta[k.toLowerCase()] ??= clean($(el).attr('content')).slice(0, 200);
  });
  if (Object.keys(meta).length) ev.meta = meta;
  const take = (sel, fn, max) => {
    const out = [];
    $(sel).each((_, el) => {
      if (out.length >= max) return false;
      const item = fn(el);
      if (item && !out.some((o) => o.path === item.path && o.value === item.value)) out.push(item);
    });
    return out.length ? out : undefined;
  };
  const text = (el, max = 120) => clean($(el).text()).slice(0, max);
  ev.times = take('time', (el) => ({ path: pathOf($, el), value: $(el).attr('datetime') ?? null, text: text(el, 60) }), 5);
  ev.authors = take('[rel~="author"], [itemprop="author"], [class*="author" i], [class*="byline" i]', (el) => {
    const t = text(el, 80);
    return t ? { path: pathOf($, el), value: t } : null;
  }, 3);
  ev.addresses = take('address, [itemprop="address"], [itemprop="streetAddress"], [class*="address" i]', (el) => {
    const t = text(el, 160);
    return t ? { path: pathOf($, el), value: t } : null;
  }, 3);
  ev.phones = take('a[href^="tel:" i]', (el) => ({ path: pathOf($, el), value: ($(el).attr('href') ?? '').slice(4).trim().slice(0, 30) }), 3);
  ev.emails = take('a[href^="mailto:" i]', (el) => ({ path: pathOf($, el), value: ($(el).attr('href') ?? '').slice(7).split('?')[0].trim().slice(0, 80) }), 3);
  // A price is a short leaf (no child element) whose text is an amount with its currency.
  const prices = [];
  $('[itemprop="price"]').each((_, el) => {
    if (prices.length < 5) prices.push({ path: pathOf($, el), value: clean($(el).attr('content') ?? $(el).text()).slice(0, PRICE_TEXT_MAX) });
  });
  $('body *').each((_, el) => {
    if (prices.length >= 5) return false;
    if ($(el).children().length || ['script', 'style', 'noscript', 'option'].includes(el.tagName)) return;
    const t = clean($(el).text());
    if (t && t.length <= PRICE_TEXT_MAX && PRICE.test(t)) {
      const path = pathOf($, el);
      if (!prices.some((p) => p.path === path && p.value === t)) prices.push({ path, value: t });
    }
  });
  if (prices.length) ev.prices = prices;
  const crumbs = $('[aria-label*="breadcrumb" i], [class*="breadcrumb" i]').first();
  if (crumbs.length) {
    const items = crumbs.find('a, li, span').map((_, el) => text(el, 60)).get().filter(Boolean);
    ev.breadcrumb = { path: pathOf($, crumbs.get(0)), items: [...new Set(items)].slice(0, 8) };
  }
  const itemprops = $('[itemprop]').length;
  if (itemprops) ev.microdata_props = itemprops;
  if ($('[property][typeof], [vocab]').length) ev.rdfa = 1;
  for (const k of Object.keys(ev)) if (ev[k] === undefined) delete ev[k];
  // Bounded: drop the longest lists first until it fits.
  let json = JSON.stringify(ev);
  for (const k of ['prices', 'addresses', 'authors', 'times', 'breadcrumb', 'meta']) {
    if (json.length <= EVIDENCE_MAX) break;
    delete ev[k];
    ev.cut = 1;
    json = JSON.stringify(ev);
  }
  return Object.keys(ev).length ? json : null;
}

/**
 * The layout of a page in 16 hex characters: the paths of its H1, its main content, and the elements
 * that show a date, a price or an address. Pages of one template share it; a template with two
 * layouts (a post with or without a price box) splits in two.
 */
function structureOf($) {
  const paths = new Set();
  const add = (sel, label) => {
    const el = $(sel).first().get(0);
    if (el) paths.add(`${label}:${pathOf($, el)}`);
  };
  add('h1', 'h1');
  add('main, [role="main"]', 'main');
  add('article', 'article');
  add('time', 'time');
  add('[itemprop="price"]', 'price');
  add('address, [itemprop="address"]', 'address');
  add('[aria-label*="breadcrumb" i], [class*="breadcrumb" i]', 'breadcrumb');
  add('form', 'form');
  if (!paths.size) return null;
  const key = [...paths].sort().join('|');
  return fnv(key, 2166136261).toString(16).padStart(8, '0') + fnv(key, 0x9747b28c).toString(16).padStart(8, '0');
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

  p.struct_sig = structureOf($);
  p.field_evidence = evidenceOf($, html);

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
  // The stored text stops at 40,000 characters: a field missing from it is unknown, not missing.
  p.text_cut = text.length > 40000 ? 1 : 0;

  return { page: p, links, text: text.slice(0, 40000) };
}
