// Post-crawl analysis: depth, inlinks, link score, indexability, near duplicates, then the audit rules.
// Most rules are one SQL query over the crawl; the few that need a walk are plain code below them.
// Writes the `issues` table and returns the summary (what an agent reads first) and report.md's text.
// Where each threshold comes from: docs/thresholds.md.
// No Node import: analyzeDb runs on any crawl database handle (schema.mjs). analyze(dir), in
// analyze.mjs, is the Node wrapper that reads and writes files.
import { hamming } from './extract.mjs';
import { readMeta, hasTable, tx, begin, commit } from './schema.mjs';
import { renderReport } from './report.mjs';

// The usual click rate by position, used to rank Search Console pages by clicks to gain.
// Backlinko, 4 million results from Search Console data (about 2022, before AI summaries): 27.6 % at
// position 1, and each position gained brings about 32.3 % more clicks. Pew Research (March 2025)
// saw clicks on results halve when an AI summary shows, so the gain only counts half the curve.
export const CLICK_CURVE = { position1: 0.276, perPosition: 1.323, aiSummaryFactor: 0.5 };

/**
 * Analyse a crawl database. Returns `{ summary, report }`; writes the analysis columns of `pages` and
 * the `issues` table. Memory stays bounded by the number of pages, not of links: link counts are SQL
 * aggregates, the link graph is read as a stream into integer arrays.
 */
export function analyzeDb(db) {
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const each = (sql, ...a) => {
    const st = db.prepare(sql);
    return typeof st.iterate === 'function' ? st.iterate(...a) : st.all(...a);
  };
  const meta = readMeta(db);
  const START = meta.start_url;

  // Only the columns the walks below need: `headers` or `schema_json` would cost megabytes per thousand pages.
  const pages = all(`SELECT url, internal, type, status, blocked_robots, meta_robots, x_robots_tag, canonical, redirect_to,
    simhash, text_hash, word_count, title, h1, lang, hreflang FROM pages`);
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const internalHtml = pages.filter((p) => p.internal && p.type === 'html');

  // Indexability, with its reason. Redirects and robots-blocked URLs have no content type, hence 'unknown'.
  for (const p of pages.filter((x) => x.internal && (x.type === 'html' || x.type === 'unknown'))) {
    const directives = `${p.meta_robots ?? ''} ${p.x_robots_tag ?? ''}`.toLowerCase();
    p.indexability = p.blocked_robots
      ? 'Blocked by robots.txt'
      : !p.status
        ? 'No response'
        : p.status >= 500
          ? 'Server error'
          : p.status >= 400
            ? 'Client error'
            : p.status >= 300
              ? 'Redirected'
              : /noindex|\bnone\b/.test(directives)
                ? 'Noindex'
                : p.canonical && p.canonical !== p.url
                  ? 'Canonicalised'
                  : 'Indexable';
    p.indexable = p.indexability === 'Indexable' ? 1 : 0;
  }

  // Integer ids for internal URLs: the graph walks below hold numbers, not strings.
  const internal = pages.filter((p) => p.internal);
  const id = new Map(internal.map((p, i) => [p.url, i]));
  const N = internal.length;

  // Crawl depth: clicks from the start URL, a redirect costs nothing. Edges as a compact adjacency list.
  const edgeSrc = [];
  const edgeDst = [];
  const edgeRedirect = [];
  for (const l of each(`SELECT src, dst, type FROM links WHERE type IN ('hyperlink','redirect')`)) {
    const a = id.get(l.src);
    const b = id.get(l.dst);
    if (a === undefined || b === undefined) continue;
    edgeSrc.push(a);
    edgeDst.push(b);
    edgeRedirect.push(l.type === 'redirect' ? 1 : 0);
  }
  const start = new Int32Array(N + 1);
  for (const a of edgeSrc) start[a + 1]++;
  for (let i = 0; i < N; i++) start[i + 1] += start[i];
  const adj = new Int32Array(edgeSrc.length);
  const adjRedirect = new Uint8Array(edgeSrc.length);
  const fill = start.slice(0, N);
  for (let e = 0; e < edgeSrc.length; e++) {
    const at = fill[edgeSrc[e]]++;
    adj[at] = edgeDst[e];
    adjRedirect[at] = edgeRedirect[e];
  }
  const depthOf = new Int32Array(N).fill(-1);
  if (id.has(START)) {
    // 0-1 breadth first: a redirect hop goes to the front of the queue, a click to the back.
    const dq = new Int32Array(Math.max(1, 2 * (edgeSrc.length + N)));
    let head = edgeSrc.length + N;
    let tail = head;
    depthOf[id.get(START)] = 0;
    dq[tail++] = id.get(START);
    while (head < tail) {
      const u = dq[head++];
      for (let k = start[u]; k < start[u + 1]; k++) {
        const v = adj[k];
        const d = depthOf[u] + (adjRedirect[k] ? 0 : 1);
        if (depthOf[v] === -1 || d < depthOf[v]) {
          depthOf[v] = d;
          if (adjRedirect[k]) dq[--head] = v;
          else dq[tail++] = v;
        }
      }
    }
  }
  const depth = { get: (u) => (id.has(u) && depthOf[id.get(u)] >= 0 ? depthOf[id.get(u)] : undefined) };

  // Inlinks and outlinks: SQL aggregates, so a million links never sit in memory.
  const stat = new Map(pages.map((p) => [p.url, { in: 0, inUnique: 0, out: 0, outUnique: 0, ext: 0 }]));
  for (const r of each(`SELECT l.dst AS url, count(*) AS n, count(DISTINCT l.src) AS u FROM links l
      JOIN pages s ON s.url = l.src AND s.internal = 1 WHERE l.type = 'hyperlink' GROUP BY l.dst`)) {
    const s = stat.get(r.url);
    if (s) Object.assign(s, { in: r.n, inUnique: r.u });
  }
  for (const r of each(`SELECT l.src AS url, sum(coalesce(d.internal, 0) = 1) AS o, count(DISTINCT CASE WHEN d.internal = 1 THEN l.dst END) AS ou,
      sum(coalesce(d.internal, 0) = 0) AS e FROM links l LEFT JOIN pages d ON d.url = l.dst WHERE l.type = 'hyperlink' GROUP BY l.src`)) {
    const s = stat.get(r.url);
    if (s) Object.assign(s, { out: r.o, outUnique: r.ou, ext: r.e });
  }

  // Link score: PageRank on followed internal links between pages that answer 200, on a 0-100 log scale.
  const nodes = internalHtml.filter((p) => p.status === 200).map((p) => p.url);
  const idx = new Map(nodes.map((u, i) => [u, i]));
  const M = nodes.length;
  const keys = [];
  for (const l of each(`SELECT src, dst FROM links WHERE type = 'hyperlink' AND coalesce(nofollow, 0) = 0 AND src != dst`)) {
    let dst = l.dst;
    for (let hop = 0; hop < 5 && byUrl.get(dst)?.redirect_to; hop++) dst = byUrl.get(dst).redirect_to;
    const a = idx.get(l.src);
    const b = idx.get(dst);
    if (a !== undefined && b !== undefined) keys.push(a * M + b);
  }
  const sorted = Float64Array.from(keys).sort();
  const outDeg = new Int32Array(M);
  const prSrc = [];
  const prDst = [];
  for (let k = 0; k < sorted.length; k++) {
    if (k && sorted[k] === sorted[k - 1]) continue;
    const a = Math.floor(sorted[k] / M);
    prSrc.push(a);
    prDst.push(sorted[k] - a * M);
    outDeg[a]++;
  }
  let pr = new Float64Array(M).fill(1 / M);
  for (let it = 0; it < 40; it++) {
    const next = new Float64Array(M).fill(0.15 / M);
    let dangling = 0;
    for (let i = 0; i < M; i++) if (!outDeg[i]) dangling += pr[i];
    for (let e = 0; e < prSrc.length; e++) next[prDst[e]] += (0.85 * pr[prSrc[e]]) / outDeg[prSrc[e]];
    for (let i = 0; i < M; i++) next[i] += (0.85 * dangling) / M;
    pr = next;
  }
  let prMin = Infinity;
  let prMax = -Infinity;
  for (const v of pr) {
    if (v < prMin) prMin = v;
    if (v > prMax) prMax = v;
  }
  const score = (v) => (prMax > prMin ? Math.round((Math.log(v / prMin) / Math.log(prMax / prMin)) * 1000) / 10 : 100);

  // Near duplicates: simhash distance <= 5 between indexable pages with a different text. Exact and
  // near linear: split the 64 bits into 6 bands; two hashes 5 bits apart or less share at least one
  // band unchanged (pigeonhole), so only pages sharing a band are compared.
  const cand = internalHtml.filter((p) => p.indexable && p.simhash && p.word_count >= 50);
  const near = new Map();
  const BANDS = [[0, 3], [3, 6], [6, 9], [9, 12], [12, 14], [14, 16]];
  const compared = new Set();
  for (let b = 0; b < BANDS.length; b++) {
    const buckets = new Map();
    cand.forEach((p, i) => {
      const k = p.simhash.slice(...BANDS[b]);
      (buckets.get(k) ?? buckets.set(k, []).get(k)).push(i);
    });
    for (const members of buckets.values()) {
      for (let x = 0; x < members.length; x++) {
        for (let y = x + 1; y < members.length; y++) {
          const i = members[x];
          const j = members[y];
          const pair = i * cand.length + j;
          if (compared.has(pair)) continue;
          compared.add(pair);
          if (cand[i].text_hash === cand[j].text_hash) continue;
          const d = hamming(cand[i].simhash, cand[j].simhash);
          if (d > 5) continue;
          for (const [a, c] of [[cand[i], cand[j]], [cand[j], cand[i]]]) {
            if (!near.has(a.url) || near.get(a.url).d > d) near.set(a.url, { url: c.url, d });
          }
        }
      }
    }
  }

  const upd = db.prepare(`UPDATE pages SET indexable=?, indexability=?, depth=?, inlinks=?, unique_inlinks=?, outlinks=?,
    unique_outlinks=?, external_outlinks=?, link_score=?, near_dup_of=?, near_dup_distance=? WHERE url=?`);
  tx(db, () => {
  for (const p of pages) {
    const s = stat.get(p.url);
    upd.run(
      p.indexable ?? null,
      p.indexability ?? null,
      depth.get(p.url) ?? null,
      s.in,
      s.inUnique,
      s.out,
      s.outUnique,
      s.ext,
      idx.has(p.url) ? score(pr[idx.get(p.url)]) : null,
      near.get(p.url)?.url ?? null,
      near.get(p.url)?.d ?? null,
      p.url,
    );
  }
  });

  // Rules
  db.exec(`
  DROP TABLE IF EXISTS issues;
  CREATE TABLE issues (url TEXT, code TEXT, category TEXT, priority TEXT, kind TEXT, label TEXT, detail TEXT);
  DROP VIEW IF EXISTS html; DROP VIEW IF EXISTS idx;
  CREATE VIEW html AS SELECT * FROM pages WHERE internal=1 AND type='html' AND status=200;
  CREATE VIEW idx AS SELECT * FROM html WHERE indexable=1;
  `);
  const hasRendered = hasTable(db, 'rendered');
  const hasAi = hasTable(db, 'ai_pages') && all('SELECT count(*) AS n FROM ai_pages')[0].n > 0;
  const header = (name) => `json_extract(lower(headers), '$.${name}')`;
  const inlinked = (where) => `SELECT p.url, count(DISTINCT l.src) || ' source page(s), e.g. ' || min(l.src) FROM pages p
    JOIN links l ON l.dst = p.url AND l.type IN ('hyperlink','image','css','js','iframe') WHERE ${where} GROUP BY p.url`;
  const dup = (col) => `SELECT url, ${col} FROM idx WHERE ${col} IS NOT NULL AND ${col} IN (SELECT ${col} FROM idx GROUP BY 1 HAVING count(*) > 1)`;

  // [code, category, priority, kind, label, sql returning (url, detail)]
  const RULES = [
    ['internal_4xx', 'Response codes', 'high', 'issue', 'Internal client error (4xx)', inlinked('p.internal=1 AND p.status BETWEEN 400 AND 499')],
    ['internal_5xx', 'Response codes', 'high', 'issue', 'Internal server error (5xx)', inlinked('p.internal=1 AND p.status >= 500')],
    ['internal_no_response', 'Response codes', 'high', 'issue', 'Internal no response', inlinked('p.internal=1 AND p.status=0')],
    ['internal_blocked_robots', 'Response codes', 'high', 'warning', 'Internal blocked by robots.txt', inlinked('p.internal=1 AND p.blocked_robots=1')],
    ['internal_3xx', 'Response codes', 'low', 'warning', 'Internal links to a redirect (3xx)', inlinked('p.internal=1 AND p.status BETWEEN 300 AND 399')],
    ['redirect_temporary', 'Response codes', 'medium', 'warning', 'Internal temporary redirect (302, 303, 307): a weak signal, Google keeps the old URL', `SELECT url, status || ' -> ' || redirect_to FROM pages WHERE internal=1 AND status IN (302, 303, 307)`],
    ['external_4xx', 'Response codes', 'low', 'warning', 'External client error (4xx)', inlinked('p.internal=0 AND p.status BETWEEN 400 AND 499')],
    ['external_5xx', 'Response codes', 'low', 'warning', 'External server error (5xx)', inlinked('p.internal=0 AND p.status >= 500')],
    ['external_no_response', 'Response codes', 'low', 'warning', 'External no response', inlinked('p.internal=0 AND p.status=0')],

    ['http_url', 'Security', 'high', 'issue', 'HTTP URLs', `SELECT url, NULL FROM pages WHERE internal=1 AND url LIKE 'http://%'`],
    ['mixed_content', 'Security', 'high', 'issue', 'Mixed content', `SELECT url, NULL FROM html WHERE mixed_content=1`],
    ['insecure_form', 'Security', 'high', 'issue', 'Form URL insecure', `SELECT url, NULL FROM html WHERE insecure_forms>0`],
    ['missing_hsts', 'Security', 'low', 'warning', 'Missing HSTS header', `SELECT url, NULL FROM html WHERE ${header('strict-transport-security')} IS NULL`],
    ['missing_csp', 'Security', 'low', 'warning', 'Missing Content-Security-Policy header', `SELECT url, NULL FROM html WHERE ${header('content-security-policy')} IS NULL`],
    ['missing_xcto', 'Security', 'low', 'warning', 'Missing X-Content-Type-Options header', `SELECT url, NULL FROM html WHERE ${header('x-content-type-options')} IS NULL`],
    ['missing_xfo', 'Security', 'low', 'warning', 'Missing X-Frame-Options header', `SELECT url, NULL FROM html WHERE ${header('x-frame-options')} IS NULL`],
    ['missing_referrer_policy', 'Security', 'low', 'warning', 'Missing secure Referrer-Policy header', `SELECT url, NULL FROM html WHERE ${header('referrer-policy')} IS NULL`],
    ['unsafe_cross_origin_links', 'Security', 'low', 'warning', 'Unsafe cross-origin links', `SELECT url, unsafe_blank_links || ' link(s)' FROM html WHERE unsafe_blank_links>0`],

    ['url_uppercase', 'URL', 'low', 'warning', 'Uppercase', `SELECT url, NULL FROM html WHERE url GLOB '*[A-Z]*'`],
    ['url_underscores', 'URL', 'low', 'opportunity', 'Underscores', `SELECT url, NULL FROM html WHERE substr(url, 9) LIKE '%\\_%' ESCAPE '\\'`],
    ['url_over_115', 'URL', 'low', 'opportunity', 'Over 115 characters', `SELECT url, length(url) FROM html WHERE length(url)>115`],
    ['url_parameters', 'URL', 'low', 'warning', 'Parameters', `SELECT url, NULL FROM pages WHERE internal=1 AND type='html' AND url LIKE '%?%'`],
    ['url_multiple_slashes', 'URL', 'low', 'issue', 'Multiple slashes', `SELECT url, NULL FROM pages WHERE internal=1 AND substr(url, 9) LIKE '%//%'`],
    ['url_space', 'URL', 'low', 'issue', 'Contains a space', `SELECT url, NULL FROM pages WHERE internal=1 AND (url LIKE '%\\%20%' ESCAPE '\\' OR url LIKE '% %')`],
    ['url_non_ascii', 'URL', 'low', 'warning', 'Non ASCII characters', `SELECT url, NULL FROM pages WHERE internal=1 AND type='html' AND url GLOB '*%[89A-Fa-f][0-9A-Fa-f]*'`],

    ['title_missing', 'Page titles', 'high', 'issue', 'Missing', `SELECT url, NULL FROM idx WHERE title IS NULL`],
    ['title_multiple', 'Page titles', 'high', 'issue', 'Multiple', `SELECT url, title_count FROM idx WHERE title_count>1`],
    ['title_outside_head', 'Page titles', 'high', 'issue', 'Outside <head>', `SELECT url, NULL FROM idx WHERE title_outside_head=1`],
    ['title_duplicate', 'Page titles', 'medium', 'opportunity', 'Duplicate', dup('title')],
    ['title_over_60', 'Page titles', 'low', 'opportunity', 'Over 60 characters', `SELECT url, title_len || ': ' || title FROM idx WHERE title_len>60`],
    ['title_below_30', 'Page titles', 'low', 'opportunity', 'Below 30 characters', `SELECT url, title_len || ': ' || title FROM idx WHERE title_len BETWEEN 1 AND 29`],
    ['title_over_px', 'Page titles', 'low', 'opportunity', 'Over 561 pixels (estimated)', `SELECT url, title_px || ' px: ' || title FROM idx WHERE title_px>561`],
    ['title_below_px', 'Page titles', 'low', 'opportunity', 'Below 200 pixels (estimated)', `SELECT url, title_px || ' px: ' || title FROM idx WHERE title_px BETWEEN 1 AND 199`],
    ['title_same_as_h1', 'Page titles', 'low', 'opportunity', 'Same as h1', `SELECT url, title FROM idx WHERE title = h1`],

    ['description_missing', 'Meta description', 'low', 'opportunity', 'Missing', `SELECT url, NULL FROM idx WHERE description IS NULL`],
    ['description_multiple', 'Meta description', 'medium', 'issue', 'Multiple', `SELECT url, description_count FROM idx WHERE description_count>1`],
    ['description_duplicate', 'Meta description', 'low', 'opportunity', 'Duplicate', dup('description')],
    ['description_over_155', 'Meta description', 'low', 'opportunity', 'Over 155 characters', `SELECT url, description_len FROM idx WHERE description_len>155`],
    ['description_below_70', 'Meta description', 'low', 'opportunity', 'Below 70 characters', `SELECT url, description_len || ': ' || description FROM idx WHERE description_len BETWEEN 1 AND 69`],

    ['description_templated', 'Meta description', 'medium', 'opportunity', 'Same opening as 5 or more other descriptions', `SELECT url, description FROM idx WHERE length(description) > 50 AND substr(description, 1, 40) IN (SELECT substr(description, 1, 40) FROM idx WHERE length(description) > 50 GROUP BY 1 HAVING count(*) >= 5)`],
    ['h1_missing', 'H1', 'medium', 'issue', 'Missing', `SELECT url, NULL FROM idx WHERE h1_count=0 OR h1 IS NULL`],
    ['h1_multiple', 'H1', 'medium', 'warning', 'Multiple', `SELECT url, h1_count FROM idx WHERE h1_count>1`],
    ['h1_duplicate', 'H1', 'low', 'opportunity', 'Duplicate', dup('h1')],
    ['h1_over_70', 'H1', 'low', 'opportunity', 'Over 70 characters', `SELECT url, h1_len FROM idx WHERE h1_len>70`],
    ['h2_missing', 'H2', 'low', 'warning', 'Missing', `SELECT url, NULL FROM idx WHERE h2_count=0`],
    ['headings_non_sequential', 'H1', 'low', 'warning', 'Non-sequential headings', `SELECT url, NULL FROM idx WHERE heading_order_ok=0`],

    ['content_exact_duplicate', 'Content', 'high', 'issue', 'Exact duplicates', dup('text_hash')],
    ['content_near_duplicate', 'Content', 'medium', 'warning', 'Near duplicates', `SELECT url, near_dup_distance || ' bits from ' || near_dup_of FROM idx WHERE near_dup_of IS NOT NULL`],
    ['content_low', 'Content', 'low', 'opportunity', 'Under 200 words, to review (Google has no preferred word count)', `SELECT url, word_count || ' words' FROM idx WHERE word_count<200`],
    ['content_lorem', 'Content', 'high', 'warning', 'Lorem ipsum placeholder', `SELECT url, NULL FROM html WHERE has_lorem=1`],
    ['content_soft_404', 'Content', 'high', 'warning', 'Soft 404 pages', `SELECT url, title FROM html WHERE lower(title) LIKE '%404%' OR lower(title) LIKE '%not found%' OR lower(h1) LIKE '%page not found%'`],

    ['image_missing_alt_attribute', 'Images', 'low', 'issue', 'Missing alt attribute', `SELECT src, count(*) || ' image(s), e.g. ' || min(dst) FROM links WHERE type='image' AND has_alt=0 GROUP BY src`],
    ['image_missing_alt_text', 'Images', 'low', 'issue', 'Missing alt text', `SELECT src, count(*) || ' image(s), e.g. ' || min(dst) FROM links WHERE type='image' AND has_alt=1 AND alt='' GROUP BY src`],
    ['image_alt_over_100', 'Images', 'low', 'opportunity', 'Alt text over 100 characters', `SELECT src, count(*) || ' image(s)' FROM links WHERE type='image' AND length(alt)>100 GROUP BY src`],
    ['image_missing_size', 'Images', 'low', 'opportunity', 'Missing size attributes', `SELECT src, count(*) || ' image(s), e.g. ' || min(dst) FROM links WHERE type='image' AND dims=0 GROUP BY src`],
    ['image_over_100kb', 'Images', 'medium', 'opportunity', 'Over 100 kB', `SELECT url, (size_bytes/1024) || ' kB' FROM pages WHERE type='image' AND size_bytes>102400`],
    ['image_legacy_format', 'Images', 'low', 'opportunity', 'PNG, JPEG or GIF over 100 kB (web.dev: prefer AVIF or WebP)', `SELECT url, content_type || ', ' || (size_bytes/1024) || ' kB' FROM pages WHERE type='image' AND size_bytes > 102400 AND (content_type LIKE 'image/png%' OR content_type LIKE 'image/jp%' OR content_type LIKE 'image/gif%')`],

    ['canonical_missing', 'Canonicals', 'medium', 'warning', 'Missing', `SELECT url, NULL FROM html WHERE canonical IS NULL AND indexability != 'Noindex'`],
    ['canonical_multiple', 'Canonicals', 'low', 'warning', 'Multiple', `SELECT url, canonical_count FROM html WHERE canonical_count>1`],
    ['canonical_canonicalised', 'Canonicals', 'high', 'warning', 'Canonicalised', `SELECT url, canonical FROM html WHERE indexability='Canonicalised'`],
    ['canonical_relative', 'Canonicals', 'low', 'warning', 'Canonical is relative', `SELECT url, NULL FROM html WHERE canonical_relative=1`],
    ['canonical_outside_head', 'Canonicals', 'high', 'issue', 'Outside <head>', `SELECT url, NULL FROM html WHERE canonical_outside_head=1`],
    ['canonical_non_indexable', 'Canonicals', 'high', 'issue', 'Non-indexable canonical', `SELECT h.url, h.canonical || ' is ' || coalesce(t.indexability, 'not crawled') FROM html h LEFT JOIN pages t ON t.url=h.canonical WHERE h.canonical IS NOT NULL AND h.canonical != h.url AND coalesce(t.indexable,0)=0`],

    ['directive_noindex', 'Directives', 'high', 'warning', 'Noindex', `SELECT url, coalesce(meta_robots,'') || ' ' || coalesce(x_robots_tag,'') FROM html WHERE indexability='Noindex'`],
    ['directive_nofollow', 'Directives', 'high', 'warning', 'Nofollow', `SELECT url, meta_robots FROM html WHERE meta_robots LIKE '%nofollow%' OR x_robots_tag LIKE '%nofollow%'`],
    ['directive_nosnippet', 'Directives', 'high', 'warning', 'nosnippet or max-snippet:0: no snippet, so no place in AI Overviews or AI Mode', `SELECT url, coalesce(meta_robots,'') || ' ' || coalesce(x_robots_tag,'') FROM idx WHERE (coalesce(meta_robots,'') || ' ' || coalesce(x_robots_tag,'')) LIKE '%nosnippet%' OR replace(coalesce(meta_robots,'') || coalesce(x_robots_tag,''), ' ', '') LIKE '%max-snippet:0%'`],
    ['discover_no_large_preview', 'Directives', 'low', 'opportunity', 'Article without max-image-preview:large (Google Discover asks for it to show a large image)', `SELECT url, meta_robots FROM idx WHERE (schema_types LIKE '%Article%' OR schema_types LIKE '%BlogPosting%') AND schema_types NOT LIKE '%TechArticle%' AND (coalesce(meta_robots,'') || coalesce(x_robots_tag,'')) NOT LIKE '%max-image-preview:large%'`],

    ['links_high_depth', 'Links', 'medium', 'opportunity', 'Pages with high crawl depth (4 clicks or more)', `SELECT url, 'depth ' || depth FROM idx WHERE depth>=4`],
    ['links_no_internal_outlinks', 'Links', 'high', 'warning', 'Pages without internal outlinks', `SELECT url, NULL FROM html WHERE outlinks=0`],
    ['links_internal_nofollow', 'Links', 'low', 'warning', 'Internal nofollow outlinks', `SELECT l.src, count(*) || ' link(s), e.g. ' || min(l.dst) FROM links l JOIN pages p ON p.url=l.dst AND p.internal=1 WHERE l.type='hyperlink' AND l.nofollow=1 GROUP BY l.src`],
    ['links_empty_anchor', 'Links', 'low', 'opportunity', 'Internal outlinks with no anchor text', `SELECT url, empty_anchors || ' link(s)' FROM html WHERE empty_anchors>0`],
    ['links_non_descriptive_anchor', 'Links', 'low', 'opportunity', 'Non-descriptive anchor text in internal outlinks', `SELECT l.src, count(*) || ' link(s), e.g. "' || min(l.anchor) || '"' FROM links l JOIN pages p ON p.url=l.dst AND p.internal=1 WHERE l.type='hyperlink' AND lower(l.anchor) IN ('click here','here','learn more','read more','more','link','this','en savoir plus','cliquez ici','ici','lire la suite') GROUP BY l.src`],
    ['links_uncrawlable', 'Links', 'high', 'warning', 'Pages with uncrawlable internal outlinks', `SELECT url, uncrawlable_links || ' link(s)' FROM html WHERE uncrawlable_links>0`],
    ['links_localhost', 'Links', 'high', 'issue', 'Outlinks to localhost', `SELECT src, min(dst) FROM links WHERE dst LIKE 'http://localhost%' OR dst LIKE 'http://127.0.0.1%' GROUP BY src`],
    ['links_few_inlinks', 'Links', 'low', 'opportunity', 'Fewer than 5 pages link to it (Zyppy study: the group with the fewest Google clicks)', `SELECT url, unique_inlinks || ' linking page(s), link score ' || link_score FROM idx WHERE unique_inlinks < 5`],
    ['links_no_contextual_inlinks', 'Links', 'low', 'opportunity', 'No link from the main content of another page, only navigation or footer', `SELECT url, unique_inlinks || ' linking page(s), none from content' FROM idx WHERE depth > 0 AND NOT EXISTS (SELECT 1 FROM links l WHERE l.dst = idx.url AND l.type='hyperlink' AND l.position='content' AND l.src != idx.url)`],
    ['links_single_anchor', 'Links', 'low', 'opportunity', 'Five or more links from content, all with the same anchor text (Zyppy: varied anchors go with more clicks)', `SELECT l.dst, count(*) || ' links, all "' || min(l.anchor) || '"' FROM links l JOIN idx p ON p.url = l.dst WHERE l.type='hyperlink' AND l.position='content' AND l.anchor IS NOT NULL AND l.src != l.dst GROUP BY l.dst HAVING count(*) >= 5 AND count(DISTINCT lower(l.anchor)) = 1`],

    ['schema_missing', 'Structured data', 'low', 'opportunity', 'Missing', `SELECT url, NULL FROM idx WHERE schema_types IS NULL`],
    ['schema_parse_error', 'Structured data', 'high', 'issue', 'Parse errors', `SELECT url, schema_parse_errors || ' block(s)' FROM html WHERE schema_parse_errors>0`],

    ['og_missing', 'Social', 'low', 'opportunity', 'Missing Open Graph tags', `SELECT url, NULL FROM idx WHERE og IS NULL`],
    ['og_incomplete', 'Social', 'low', 'warning', 'Incomplete Open Graph tags', `SELECT url, NULL FROM idx WHERE og IS NOT NULL AND (json_extract(og,'$."og:title"') IS NULL OR json_extract(og,'$."og:type"') IS NULL OR json_extract(og,'$."og:image"') IS NULL OR json_extract(og,'$."og:url"') IS NULL)`],
    ['og_url_non_canonical', 'Social', 'low', 'warning', 'Non-canonical og:url', `SELECT url, json_extract(og,'$."og:url"') FROM idx WHERE json_extract(og,'$."og:url"') IS NOT NULL AND json_extract(og,'$."og:url"') != coalesce(canonical, url)`],
    ['og_image_non_200', 'Social', 'low', 'issue', 'Non-200 og:image URL', `SELECT l.src, l.dst || ' -> ' || p.status FROM links l JOIN pages p ON p.url=l.dst WHERE l.type='og-image' AND p.status != 200`],
    ['og_image_small', 'Social', 'low', 'opportunity', 'og:image declared under 1,200 px wide (the width Google Discover asks for)', `SELECT url, json_extract(og,'$."og:image:width"') || ' px' FROM idx WHERE CAST(json_extract(og,'$."og:image:width"') AS INTEGER) BETWEEN 1 AND 1199`],
    ['twitter_missing', 'Social', 'low', 'opportunity', 'Missing X cards', `SELECT url, NULL FROM idx WHERE twitter IS NULL`],

    ['sitemap_not_in', 'Sitemaps', 'medium', 'issue', 'Indexable URLs not in sitemap', `SELECT url, NULL FROM idx WHERE in_sitemap=0`],
    ['sitemap_orphan', 'Sitemaps', 'medium', 'issue', 'Orphan URLs (in a sitemap, reached by no internal link)', `SELECT url, NULL FROM pages WHERE internal=1 AND in_sitemap=1 AND depth IS NULL`],
    ['sitemap_non_indexable', 'Sitemaps', 'medium', 'issue', 'Non-indexable URLs in sitemap', `SELECT url, coalesce(indexability, 'status ' || status) FROM pages WHERE internal=1 AND in_sitemap=1 AND coalesce(indexable,0)=0`],
    ['sitemap_over_limit', 'Sitemaps', 'high', 'issue', 'Sitemap over 50,000 URLs (Google limit)', `SELECT url, urls || ' URLs' FROM sitemaps WHERE kind='urlset' AND urls > 50000`],

    ['validation_html_over_2mb', 'Validation', 'high', 'issue', 'HTML over 2 MB', `SELECT url, (size_bytes/1024) || ' kB' FROM html WHERE size_bytes>2097152`],
    ['mobile_viewport_missing', 'Mobile', 'high', 'issue', 'Viewport not set', `SELECT url, NULL FROM html WHERE viewport IS NULL`],
    ['lang_missing', 'Hreflang', 'low', 'warning', 'Missing html lang attribute', `SELECT url, NULL FROM html WHERE lang IS NULL`],
    ['ttfb_needs_improvement', 'Response time', 'low', 'opportunity', 'Time to first byte over 0.8 s (web.dev: needs improvement)', `SELECT url, ttfb_ms || ' ms' FROM html WHERE ttfb_ms > 800 AND ttfb_ms <= 1800`],
    ['ttfb_poor', 'Response time', 'medium', 'warning', 'Time to first byte over 1.8 s (web.dev: poor)', `SELECT url, ttfb_ms || ' ms' FROM html WHERE ttfb_ms > 1800`],
    ['html_over_p90', 'Response time', 'low', 'opportunity', 'HTML document heavier than 90 % of the web (over 151 kB, Web Almanac 2025)', `SELECT url, (size_bytes/1024) || ' kB' FROM html WHERE size_bytes > 151 * 1024`],
    ['dom_over_1400', 'Response time', 'low', 'opportunity', 'Over 1,400 DOM nodes (where Lighthouse fails the DOM size audit)', `SELECT url, dom_nodes || ' nodes' FROM html WHERE dom_nodes > 1400`],
    ['ai_no_markdown', 'AI readiness', 'low', 'opportunity', 'No Markdown version, while other pages of the site have one (a bet: Google says it needs no such file)', `SELECT url, NULL FROM idx WHERE md_alternate IS NULL AND NOT EXISTS (SELECT 1 FROM pages m WHERE m.url = idx.url || '.md' AND m.status=200) AND (SELECT count(*) FROM pages WHERE md_alternate IS NOT NULL) > 0`],
  ];
  if (hasAi) {
    RULES.push(
      ['ai_description_misfit', 'Content quality (AI)', 'medium', 'opportunity', 'Meta description does not say what the page contains (AI score under 0.3)', `SELECT a.url, round(a.description_fit,2) || ': ' || coalesce(p.description,'(none)') FROM ai_pages a JOIN pages p USING(url) WHERE a.description_fit < 0.3`],
      ['ai_title_misfit', 'Content quality (AI)', 'medium', 'opportunity', 'Title does not describe the page (AI score under 0.3)', `SELECT a.url, round(a.title_fit,2) || ': ' || coalesce(p.title,'(none)') FROM ai_pages a JOIN pages p USING(url) WHERE a.title_fit < 0.3`],
      ['ai_not_answer_first', 'Content quality (AI)', 'low', 'opportunity', 'Opening does not get to the point (AI score under 0.3)', `SELECT a.url, round(a.answer_first,2) || ': ' || substr(t.text,1,110) FROM ai_pages a JOIN texts t USING(url) WHERE a.answer_first < 0.3`],
      ['ai_thin', 'Content quality (AI)', 'medium', 'warning', 'Thin page (AI score over 0.7)', `SELECT a.url, round(a.thin,2) || ', ' || p.word_count || ' words' FROM ai_pages a JOIN pages p USING(url) WHERE a.thin > 0.7`],
      ['ai_soft_404', 'Content quality (AI)', 'high', 'warning', 'Reads like an error page but answers 200 (AI score over 0.7)', `SELECT a.url, round(a.error_page,2) FROM ai_pages a WHERE a.error_page > 0.7`],
      ['ai_cannibalisation', 'Cannibalisation (AI)', 'high', 'warning', 'Two pages target the same search (AI score 0.75 or more)', `SELECT a, round(p,2) || ' with ' || b FROM ai_cannibal WHERE p >= 0.75`],
      ['ai_cannibalisation_review', 'Cannibalisation (AI)', 'low', 'opportunity', 'Pages with close targets, to review (AI score 0.5 to 0.75)', `SELECT a, round(p,2) || ' with ' || b FROM ai_cannibal WHERE p >= 0.5 AND p < 0.75`],
      ['ai_link_opportunity', 'Links (AI)', 'medium', 'opportunity', 'Names the subject of another page without linking to it (AI score 0.8 or more)', `SELECT source, 'link "' || phrase || '" to ' || target || ' (' || round(p,2) || ')' FROM ai_link_opps WHERE p >= 0.8`],
    );
  }
  const hasGsc = hasTable(db, 'gsc_pages');
  const hasOpps = hasTable(db, 'ai_link_opps');
  if (hasGsc) {
    const G = 'Search Console';
    const figures = `g.impressions || ' impressions, ' || g.clicks || ' clicks, position ' || round(g.position,1)`;
    RULES.push(
      ['gsc_lost_page', G, 'high', 'issue', 'Shown in Google but answers an error today', `SELECT g.url, ${figures} || ', status ' || g.status_now FROM gsc_pages g WHERE g.same_site=1 AND g.in_crawl=0 AND (g.status_now >= 400 OR g.status_now = 0) AND g.impressions >= 10`],
      ['gsc_non_indexable_with_impressions', G, 'medium', 'warning', 'Non-indexable URL with impressions in Google', `SELECT g.url, ${figures} || ', ' || coalesce(p.indexability, 'status ' || p.status) FROM gsc_pages g JOIN pages p USING(url) WHERE p.internal=1 AND p.type='html' AND coalesce(p.indexable,0)=0`],
      ['gsc_orphan', G, 'medium', 'issue', 'Orphan URL: shown in Google, reached by no link and no sitemap', `SELECT g.url, ${figures} FROM gsc_pages g WHERE g.same_site=1 AND g.in_crawl=0 AND g.status_now=200`],
      ['gsc_old_url', G, 'low', 'warning', 'Old URL still shown in Google, now redirected', `SELECT g.url, ${figures} || ' -> ' || g.redirect_now FROM gsc_pages g WHERE g.same_site=1 AND g.in_crawl=0 AND g.status_now BETWEEN 300 AND 399`],
      ['gsc_old_url_temporary', G, 'medium', 'warning', 'Old URL shown in Google behind a temporary redirect (302, 307): only a 301 or 308 moves it', `SELECT g.url, ${figures} || ', ' || g.status_now || ' -> ' || g.redirect_now FROM gsc_pages g WHERE g.same_site=1 AND g.in_crawl=0 AND g.status_now IN (302, 303, 307)`],
      ['gsc_not_indexed', G, 'medium', 'issue', 'Indexable page that Google has not indexed (URL inspection)', `SELECT i.url, i.coverage || coalesce(', last crawl ' || substr(i.last_crawl,1,10), '') FROM gsc_inspect i WHERE i.coverage NOT LIKE '%and indexed%' AND i.coverage NOT LIKE 'Indexed%'`],
      ['gsc_canonical_differs', G, 'high', 'issue', 'Google chose another canonical than the one declared', `SELECT url, 'Google: ' || google_canonical || ', declared when Google last crawled it (' || coalesce(substr(last_crawl,1,10), 'unknown') || '): ' || user_canonical FROM gsc_inspect WHERE google_canonical IS NOT NULL AND user_canonical IS NOT NULL AND google_canonical != user_canonical`],
      ['gsc_no_impressions', G, 'low', 'opportunity', 'Indexable page with no impression in Google over the window', `SELECT url, 'link score ' || link_score FROM idx WHERE url NOT IN (SELECT url FROM gsc_pages)`],
    );
  }
  if (hasRendered) {
    RULES.push(
      ['js_content', 'JavaScript', 'medium', 'warning', 'Content that only exists after JavaScript (20 % more words): GPTBot, ClaudeBot and PerplexityBot do not run it', `SELECT r.url, p.word_count || ' -> ' || r.word_count || ' words' FROM rendered r JOIN pages p USING(url) WHERE r.word_count > p.word_count * 1.2`],
      ['js_links', 'JavaScript', 'medium', 'warning', 'Contains JavaScript links', `SELECT r.url, r.new_links || ' link(s) only in the rendered DOM' FROM rendered r WHERE r.new_links>0`],
      ['js_title', 'JavaScript', 'medium', 'warning', 'Page title updated by JavaScript', `SELECT r.url, r.title FROM rendered r JOIN pages p USING(url) WHERE coalesce(r.title,'') != coalesce(p.title,'')`],
      ['js_h1', 'JavaScript', 'medium', 'warning', 'H1 updated by JavaScript', `SELECT r.url, r.h1 FROM rendered r JOIN pages p USING(url) WHERE coalesce(r.h1,'') != coalesce(p.h1,'')`],
      ['js_canonical', 'JavaScript', 'high', 'issue', 'Canonical mismatch', `SELECT r.url, r.canonical FROM rendered r JOIN pages p USING(url) WHERE coalesce(r.canonical,'') != coalesce(p.canonical,'')`],
      ['js_errors', 'JavaScript', 'low', 'warning', 'Pages with JavaScript errors', `SELECT url, json_array_length(console_errors) || ' error(s): ' || substr(json_extract(console_errors,'$[0]'),1,140) FROM rendered WHERE json_array_length(console_errors)>0`],
      ['a11y_violations', 'Accessibility', 'medium', 'warning', 'axe-core violations', `SELECT r.url, group_concat(json_extract(v.value,'$.id') || ' x' || json_extract(v.value,'$.nodes'), ', ') FROM rendered r, json_each(r.axe) v GROUP BY r.url`],
      ['perf_lcp', 'PageSpeed', 'medium', 'opportunity', 'LCP over 2.5 s (lab, local Chrome)', `SELECT url, lcp_ms || ' ms' FROM rendered WHERE lcp_ms>2500`],
      ['perf_cls', 'PageSpeed', 'medium', 'opportunity', 'CLS over 0.1 (lab, local Chrome)', `SELECT url, cls FROM rendered WHERE cls>0.1`],
      ['lcp_lazy', 'PageSpeed', 'medium', 'warning', 'The LCP image is lazy-loaded (web.dev: never lazy-load it)', `SELECT url, lcp_url FROM rendered WHERE lcp_tag='IMG' AND lcp_lazy=1`],
      ['lcp_no_priority', 'PageSpeed', 'low', 'opportunity', 'The LCP image has no fetchpriority="high"', `SELECT url, lcp_url FROM rendered WHERE lcp_tag='IMG' AND coalesce(lcp_priority,'') != 'high'`],
    );
  }
  const insertIssue = db.prepare('INSERT INTO issues VALUES (?,?,?,?,?,?,?)');
  begin(db);
  for (const [code, category, priority, kind, label, sql] of RULES) {
    for (const row of all(sql)) {
      const [url, detail] = Object.values(row);
      insertIssue.run(url, code, category, priority, kind, label, detail === null || detail === undefined ? null : String(detail));
    }
  }

  // Rules that need a walk rather than a query
  const issue = (url, code, category, priority, kind, label, detail) => insertIssue.run(url, code, category, priority, kind, label, detail ?? null);
  for (const p of pages.filter((x) => x.internal && x.redirect_to)) {
    const chain = [p.url];
    let cur = p;
    let loop = false;
    while (cur?.redirect_to && chain.length < 12) {
      if (chain.includes(cur.redirect_to)) {
        loop = true;
        break;
      }
      chain.push(cur.redirect_to);
      cur = byUrl.get(cur.redirect_to);
    }
    if (loop) issue(p.url, 'redirect_loop', 'Response codes', 'high', 'issue', 'Internal redirect loop', chain.join(' -> '));
    else if (chain.length > 2) issue(p.url, 'redirect_chain', 'Response codes', 'medium', 'warning', 'Internal redirect chain', chain.join(' -> '));
  }
  const langRe = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;
  for (const p of internalHtml.filter((x) => x.status === 200 && x.hreflang)) {
    const alts = JSON.parse(p.hreflang);
    const H = (code, priority, kind, label, detail) => issue(p.url, code, 'Hreflang', priority, kind, label, detail);
    if (!alts.some((a) => a.href === p.url)) H('hreflang_missing_self', 'low', 'warning', 'Missing self reference');
    if (!alts.some((a) => a.lang?.toLowerCase() === 'x-default')) H('hreflang_missing_x_default', 'low', 'warning', 'Missing x-default');
    const bad = alts.filter((a) => !langRe.test(a.lang ?? ''));
    if (bad.length) H('hreflang_bad_code', 'high', 'issue', 'Incorrect language and region codes', bad.map((a) => a.lang).join(', '));
    const langs = alts.map((a) => a.lang?.toLowerCase());
    if (new Set(langs).size < langs.length) H('hreflang_multiple', 'high', 'issue', 'Multiple entries for a language');
    const dead = alts.filter((a) => a.href && byUrl.has(a.href) && byUrl.get(a.href).status !== 200);
    if (dead.length) H('hreflang_non_200', 'high', 'issue', 'Non-200 hreflang URLs', dead.map((a) => `${a.lang}: ${a.href} (${byUrl.get(a.href).status})`).join(', '));
    const noReturn = alts.filter((a) => {
      const t = a.href && a.href !== p.url ? byUrl.get(a.href) : null;
      return t && t.status === 200 && !(t.hreflang ? JSON.parse(t.hreflang) : []).some((b) => b.href === p.url);
    });
    if (noReturn.length) H('hreflang_no_return', 'high', 'issue', 'Missing return links', noReturn.map((a) => `${a.lang}: ${a.href}`).join(', '));
    const nonCanon = alts.filter((a) => {
      const t = a.href ? byUrl.get(a.href) : null;
      return t && t.status === 200 && t.indexable === 0;
    });
    if (nonCanon.length) H('hreflang_non_indexable', 'high', 'issue', 'Hreflang to a non-indexable URL', nonCanon.map((a) => `${a.lang}: ${a.href}`).join(', '));
    const base = p.lang?.toLowerCase().split('-')[0];
    const self = alts.find((a) => a.href === p.url && a.lang?.toLowerCase() !== 'x-default');
    if (self && base && self.lang.toLowerCase().split('-')[0] !== base) H('hreflang_lang_mismatch', 'medium', 'warning', 'Mismatch with html lang attribute', `${self.lang} vs ${p.lang}`);
  }
  if (meta.missing_page_status && meta.missing_page_status !== '404' && meta.missing_page_status !== '410') {
    issue(START, 'site_soft_404', 'Content', 'high', 'warning', 'Unknown URLs do not answer 404', `status ${meta.missing_page_status}`);
  }
  // Structured data against what Google's rich results ask for: a small hand-written subset.
  const visit = (node, fn) => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, fn));
    if (!node || typeof node !== 'object') return;
    fn(node);
    Object.values(node).forEach((v) => visit(v, fn));
  };
  const typeIs = (n, ...names) => [].concat(n['@type'] ?? []).some((t) => names.includes(t));
  const missing = (n, props) => props.filter((k) => n[k] === undefined || n[k] === null || n[k] === '');
  for (const p of each("SELECT url, schema_json FROM pages WHERE internal=1 AND type='html' AND status=200 AND schema_json IS NOT NULL")) {
    const errors = new Set();
    const warnings = new Set();
    visit(JSON.parse(p.schema_json), (n) => {
      if (typeIs(n, 'Article', 'BlogPosting', 'NewsArticle', 'TechArticle')) {
        const m = missing(n, ['headline', 'image', 'datePublished', 'author']);
        if (m.length) warnings.add(`${[].concat(n['@type'])[0]} without ${m.join(', ')}`);
      }
      if (typeIs(n, 'BreadcrumbList')) {
        const items = [].concat(n.itemListElement ?? []);
        if (!items.length) errors.add('BreadcrumbList without itemListElement');
        items.forEach((it, i) => {
          const m = [];
          if (it.position === undefined) m.push('position');
          if (!it.name && !it.item?.name) m.push('name');
          if (i < items.length - 1 && !it.item) m.push('item');
          if (m.length) errors.add(`BreadcrumbList item ${i + 1} without ${m.join(', ')}`);
        });
      }
      if (typeIs(n, 'FAQPage')) {
        const qs = [].concat(n.mainEntity ?? []);
        if (!qs.length) errors.add('FAQPage without mainEntity');
        if (qs.some((q) => !q.name || !q.acceptedAnswer?.text)) errors.add('FAQPage question without name or acceptedAnswer.text');
      }
      if (typeIs(n, 'Product')) {
        if (!n.name) errors.add('Product without name');
        if (!n.offers && !n.review && !n.aggregateRating) errors.add('Product needs offers, review or aggregateRating');
      }
    });
    if (errors.size) issue(p.url, 'schema_rich_result_errors', 'Structured data', 'high', 'issue', 'Rich result validation errors (subset)', [...errors].join('; '));
    if (warnings.size) issue(p.url, 'schema_rich_result_warnings', 'Structured data', 'low', 'opportunity', 'Rich result validation warnings (subset)', [...warnings].join('; '));
  }

  // How the site presents itself to AI crawlers and agents
  const air = meta.ai_readiness ? JSON.parse(meta.ai_readiness) : null;
  if (air) {
    const A = (code, priority, kind, label, detail) => issue(START, code, 'AI readiness', priority, kind, label, detail);
    if (air.llms_txt.status !== 200 || /html/.test(air.llms_txt.content_type ?? '')) A('ai_no_llms_txt', 'low', 'opportunity', 'No /llms.txt (optional: Google says it does not use it)', `status ${air.llms_txt.status}, ${air.llms_txt.content_type}`);
    const blocked = Object.entries(air.bots).filter(([, b]) => !b.allowed).map(([n]) => n);
    if (blocked.length) A('ai_bots_blocked', 'medium', 'warning', 'AI crawlers disallowed in robots.txt', blocked.join(', '));
    if (air.home_as_gptbot.status !== 200) A('ai_gptbot_refused', 'high', 'warning', 'Home page refuses a GPTBot user-agent', `status ${air.home_as_gptbot.status}`);
    if (!/markdown/.test(air.home_as_markdown.content_type ?? '')) A('ai_no_markdown_negotiation', 'low', 'opportunity', 'Home page does not answer Accept: text/markdown with Markdown', air.home_as_markdown.content_type);
  }
  // Search Console against a usual click curve. Backlinko's study of 4 million results (Search Console data, about 2022,
  // before AI summaries): 27.6 % at position 1, and each position lower loses about a quarter (32.3 % more per position gained).
  // Pew Research (March 2025) saw clicks on results halve when an AI summary shows: the gain below counts half the curve.
  let potential = [];
  if (hasGsc) {
    const usual = (pos) => CLICK_CURVE.position1 / CLICK_CURVE.perPosition ** (Math.min(Math.max(pos, 1), 20) - 1);
    const brandName = meta.host.split('.')[0];
    const brandShare = new Map(all('SELECT url, sum(CASE WHEN instr(query, ?) > 0 THEN impressions ELSE 0 END) * 1.0 / sum(impressions) AS share FROM gsc_queries GROUP BY url', brandName).map((r) => [r.url, r.share]));
    const proposed = hasOpps ? db.prepare('SELECT count(*) AS n FROM ai_link_opps WHERE target=? AND p >= 0.8') : null;
    for (const g of all('SELECT g.url, g.clicks, g.impressions, g.ctr, g.position, p.title, p.link_score, p.unique_inlinks FROM gsc_pages g JOIN idx p USING(url) WHERE g.impressions >= 100')) {
      if ((brandShare.get(g.url) ?? 0) > 0.5) continue; // a page shown mostly for the brand name follows another curve
      const pct = (v) => `${(v * 100).toFixed(1)} %`;
      if (g.position <= 10 && g.ctr < usual(g.position) * 0.25) {
        issue(g.url, 'gsc_ctr_gap', 'Search Console', 'medium', 'opportunity', 'On page 1 with a click rate under a quarter of the usual rate at that position: title and description to rework',
          `${pct(g.ctr)} for a usual ${pct(usual(g.position))} at position ${g.position.toFixed(1)}, ${g.impressions} impressions, title: ${g.title ?? ''}`);
      }
      if (g.position > 3 && g.position <= 20) {
        const gain = Math.round(g.impressions * usual(3) * CLICK_CURVE.aiSummaryFactor - g.clicks);
        if (gain < 1) continue;
        const weak = g.link_score < 40;
        const links = proposed ? proposed.get(g.url).n : null;
        potential.push({ url: g.url, impressions: g.impressions, clicks: g.clicks, position: Math.round(g.position * 10) / 10, link_score: g.link_score, linking_pages: g.unique_inlinks, weakly_linked: weak, links_proposed: links, clicks_to_gain_at_position_3: gain });
        issue(g.url, weak ? 'gsc_striking_weak_links' : 'gsc_striking_distance', 'Search Console', weak ? 'medium' : 'low', 'opportunity',
          weak ? 'Position 4 to 20, 100 impressions or more, link score under 40: internal links are the cheapest push' : 'Position 4 to 20, 100 impressions or more, already well linked',
          `position ${g.position.toFixed(1)}, ${g.impressions} impressions, ${g.clicks} clicks, link score ${g.link_score}, ${g.unique_inlinks} linking page(s), up to ${gain} more clicks at position 3`);
      }
    }
    potential.sort((a, b) => b.clicks_to_gain_at_position_3 - a.clicks_to_gain_at_position_3);
  }

  // Sitemap lastmod: Google only uses it when it is consistently accurate
  const sm = hasTable(db, 'sitemap_urls') ? all('SELECT count(*) AS n, count(lastmod) AS dated, count(DISTINCT substr(lastmod,1,10)) AS days FROM sitemap_urls')[0] : null;
  if (sm?.n) {
    if (sm.dated < sm.n) issue(START, 'sitemap_no_lastmod', 'Sitemaps', 'low', 'opportunity', 'Sitemap URLs without lastmod', `${sm.n - sm.dated} of ${sm.n} URLs`);
    else if (sm.n >= 20 && sm.days === 1) issue(START, 'sitemap_lastmod_identical', 'Sitemaps', 'low', 'warning', 'Every sitemap lastmod is the same day: Google ignores a lastmod that is not accurate', `${sm.n} URLs, one date`);
  }

  // Site name: Google reads WebSite structured data on the home page
  {
    const home = db.prepare('SELECT status, schema_json FROM pages WHERE url = ?').get(START);
    let named = false;
    if (home?.schema_json) visit(JSON.parse(home.schema_json), (n) => { if (typeIs(n, 'WebSite') && n.name && n.url) named = true; });
    if (home?.status === 200 && !named) issue(START, 'site_name_schema', 'Structured data', 'low', 'opportunity', 'Home page without WebSite structured data (name and url): the source Google prefers for the site name');
  }

  // Obsolete titles: a past year in the title or the h1, one of the reasons Google rewrites a title
  const crawlYear = Number((meta.started_at ?? '').slice(0, 4)) || new Date().getFullYear();
  for (const p of internalHtml.filter((x) => x.status === 200 && x.indexable)) {
    const years = [...`${p.title ?? ''} ${p.h1 ?? ''}`.matchAll(/\b(20[1-4]\d)\b/g)].map((m) => Number(m[1]));
    if (years.length && Math.max(...years) < crawlYear) issue(p.url, 'content_stale_year', 'Content', 'medium', 'opportunity', 'Title names a past year', p.title);
  }

  // Evidence in articles. GEO study (Princeton and others, KDD 2024, 10,000 queries): quotations, statistics and cited sources
  // were the edits that raised visibility in generative answers the most; keyword stuffing lowered it.
  {
    const aiType = hasAi ? new Map(all('SELECT url, page_type, intent FROM ai_pages').map((r) => [r.url, r])) : new Map();
    const ext = new Map(all(`SELECT l.src, count(DISTINCT l.dst) AS n FROM links l JOIN pages p ON p.url = l.dst WHERE l.type='hyperlink' AND l.position='content' AND p.internal=0 GROUP BY l.src`).map((r) => [r.src, r.n]));
    const figure = /[$€£]\s?\d|\b\d[\d,.]*\s?(?:%|percent|x\b|times\b|million|billion|ms\b|seconds?\b|minutes?\b|hours?\b|days?\b|users\b|customers\b|€|\$)/gi;
    for (const t of each("SELECT t.url, t.text, p.word_count, p.schema_types FROM texts t JOIN pages p USING(url) WHERE p.internal=1 AND p.indexable=1 AND p.word_count >= 500")) {
      const a = aiType.get(t.url);
      const article = /"(Article|BlogPosting|NewsArticle)"/.test(t.schema_types ?? '') || /blog_article|^article$|blog_post|news/.test(a?.page_type ?? '');
      if (!article) continue;
      const figures = (t.text.match(figure) ?? []).length;
      const sources = ext.get(t.url) ?? 0;
      if (sources === 0) issue(t.url, 'geo_no_cited_source', 'AI readiness', 'low', 'opportunity', 'Article without a single link to an outside source (GEO study: citing sources raised visibility in AI answers)', `${t.word_count} words, ${figures} figure(s)`);
      if (figures < 3) issue(t.url, 'geo_few_statistics', 'AI readiness', 'low', 'opportunity', 'Article with fewer than 3 figures (GEO study: adding statistics raised visibility in AI answers)', `${t.word_count} words, ${figures} figure(s), ${sources} outside source(s)`);
    }
  }

  // Search Console: one query, two or more of our pages each taking a real share of its impressions
  if (hasGsc) {
    const byQuery = new Map();
    for (const r of all(`SELECT q.query, q.url, q.impressions, q.clicks, q.position FROM gsc_queries q JOIN pages p USING(url)
      WHERE p.internal=1 AND p.indexable=1 AND q.impressions >= 10 ORDER BY q.impressions DESC`)) {
      if (!byQuery.has(r.query)) byQuery.set(r.query, []);
      byQuery.get(r.query).push(r);
    }
    const brand = meta.host.split('.')[0];
    for (const [q, rows] of byQuery) {
      if (q.includes(brand)) continue; // a brand search shows several of our pages by design
      const rivals = rows.filter((r) => r.impressions >= rows[0].impressions * 0.2);
      if (rivals.length < 2) continue;
      issue(rivals[0].url, 'gsc_query_cannibalisation', 'Search Console', 'medium', 'warning', 'One Google query split between several of our pages',
        `"${q}": ${rivals.map((r) => `${r.url} (${r.impressions} impressions, position ${r.position.toFixed(1)})`).join(' vs ')}`);
    }
  }
  if (meta.sitemaps_declared_in_robots === '0') issue(START, 'sitemap_not_in_robots', 'Sitemaps', 'low', 'warning', 'No sitemap declared in robots.txt');
  commit(db);

  // Outputs
  const one = (sql) => Object.values(all(sql)[0])[0];
  const issues = all(`SELECT code, category, priority, kind, label, count(*) AS urls FROM issues GROUP BY code
    ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, CASE kind WHEN 'issue' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, urls DESC`);
  const examples = db.prepare('SELECT url, detail FROM issues WHERE code=? ORDER BY url LIMIT 5');
  for (const i of issues) i.examples = examples.all(i.code);
  const summary = {
    site: START,
    crawled_at: meta.started_at,
    seconds: Number(meta.seconds),
    user_agent: meta.user_agent,
    urls: {
      total: pages.length,
      internal: one('SELECT count(*) FROM pages WHERE internal=1'),
      external: one('SELECT count(*) FROM pages WHERE internal=0'),
      skipped_over_max: Number(meta.skipped_over_max),
      by_type: all('SELECT internal, type, count(*) AS n FROM pages GROUP BY 1,2 ORDER BY 1 DESC, 3 DESC'),
      by_status: all('SELECT internal, status, count(*) AS n FROM pages GROUP BY 1,2 ORDER BY 1 DESC, 2'),
    },
    html_pages: {
      total: internalHtml.length,
      indexability: all("SELECT indexability, count(*) AS n FROM pages WHERE internal=1 AND type='html' GROUP BY 1 ORDER BY 2 DESC"),
      by_depth: all('SELECT depth, count(*) AS n FROM html GROUP BY 1 ORDER BY 1'),
      by_lang: all('SELECT lang, count(*) AS n FROM html GROUP BY 1 ORDER BY 2 DESC'),
      words_median: one('SELECT word_count FROM html ORDER BY word_count LIMIT 1 OFFSET (SELECT count(*)/2 FROM html)'),
      ttfb_ms_median: one('SELECT ttfb_ms FROM html ORDER BY ttfb_ms LIMIT 1 OFFSET (SELECT count(*)/2 FROM html)'),
      html_kb_median: one('SELECT size_bytes/1024 FROM html ORDER BY size_bytes LIMIT 1 OFFSET (SELECT count(*)/2 FROM html)'),
    },
    sitemaps: all('SELECT * FROM sitemaps'),
    links: all('SELECT type, count(*) AS n FROM links GROUP BY 1 ORDER BY 2 DESC'),
    schema_types: all("SELECT v.value AS type, count(*) AS pages FROM html, json_each(html.schema_types) v GROUP BY 1 ORDER BY 2 DESC"),
    top_link_score: all('SELECT url, link_score, unique_inlinks, depth FROM idx ORDER BY link_score DESC LIMIT 15'),
    weakest_linked: all('SELECT url, link_score, unique_inlinks, depth FROM idx ORDER BY link_score ASC, unique_inlinks ASC LIMIT 15'),
    slowest: all('SELECT url, ttfb_ms FROM html ORDER BY ttfb_ms DESC LIMIT 10'),
    heaviest_html: all('SELECT url, size_bytes/1024 AS kb, word_count, dom_nodes FROM html ORDER BY size_bytes DESC LIMIT 10'),
    rules_run: RULES.length + 24 + (hasGsc ? 4 : 0), // walks in code: redirects 2, hreflang 8, site 2, rich results 2, AI readiness 4, sitemap lastmod 2, site name 1, past year 1, evidence 2, GSC 4
    ai_readiness: air,
    markdown_versions: { pages: one('SELECT count(*) FROM idx WHERE md_alternate IS NOT NULL'), of: one('SELECT count(*) FROM idx') },
    indexable_pages: one('SELECT count(*) FROM idx'),
    issues,
  };
  // Segments: the first path segment (language prefix left out), and the AI page type when the AI layer ran
  const origin = new URL(START).origin;
  const sectionOf = (u) => new URL(u).pathname.split('/').filter(Boolean).filter((x, i) => !(i === 0 && /^[a-z]{2}(-[a-z]{2})?$/i.test(x)))[0] ?? '(home)';
  const seg = new Map();
  const gscByUrl = new Map(hasGsc ? all('SELECT url, clicks, impressions FROM gsc_pages').map((r) => [r.url, r]) : []);
  const issueCount = new Map(all("SELECT url, count(*) AS n FROM issues WHERE priority != 'low' GROUP BY url").map((r) => [r.url, r.n]));
  for (const r of all('SELECT url, word_count, link_score, unique_inlinks FROM idx')) {
    const k = sectionOf(r.url);
    const g = seg.get(k) ?? seg.set(k, { section: k, pages: 0, words: 0, link_score: 0, inlinks: 0, issues: 0, clicks: 0, impressions: 0, shown: 0 }).get(k);
    const gs = gscByUrl.get(r.url);
    if (gs) {
      g.clicks += gs.clicks;
      g.impressions += gs.impressions;
      g.shown++;
    }
    g.pages++;
    g.words += r.word_count;
    g.link_score += r.link_score ?? 0;
    g.inlinks += r.unique_inlinks;
    g.issues += issueCount.get(r.url) ?? 0;
  }
  summary.sections = [...seg.values()].sort((a, b) => b.pages - a.pages).map((g) => ({ section: g.section, pages: g.pages, words_avg: Math.round(g.words / g.pages), link_score_avg: Math.round((g.link_score / g.pages) * 10) / 10, inlinks_avg: Math.round((g.inlinks / g.pages) * 10) / 10, issues_medium_high: g.issues, ...(hasGsc ? { pages_shown_in_google: g.shown, impressions: g.impressions, clicks: g.clicks } : {}) }));
  if (hasGsc) {
    summary.gsc = {
      ...JSON.parse(meta.gsc),
      pages_with_impressions: all('SELECT count(*) AS n FROM gsc_pages WHERE same_site=1')[0].n,
      indexable_pages_shown: all('SELECT count(*) AS n FROM idx WHERE url IN (SELECT url FROM gsc_pages)')[0].n,
      indexable_pages: all('SELECT count(*) AS n FROM idx')[0].n,
      top_pages: all(`SELECT g.url, g.clicks, g.impressions, round(g.ctr*100,1) AS ctr_pct, round(g.position,1) AS position, p.link_score,
        (SELECT query FROM gsc_queries q WHERE q.url=g.url ORDER BY impressions DESC LIMIT 1) AS top_query
        ${hasAi ? ', (SELECT target_query FROM ai_pages a WHERE a.url=g.url) AS target_query' : ''}
        FROM gsc_pages g LEFT JOIN pages p USING(url) WHERE g.same_site=1 ORDER BY g.impressions DESC LIMIT 25`),
      top_queries: all('SELECT query, clicks, impressions, round(position,1) AS position FROM gsc_site_queries ORDER BY impressions DESC LIMIT 25'),
      inspection: all('SELECT coverage, count(*) AS pages FROM gsc_inspect GROUP BY 1 ORDER BY 2 DESC'),
      potential,
    };
    if (hasAi) {
      summary.gsc.by_page_type = all(`SELECT a.page_type, count(*) AS pages, sum(g.url IS NOT NULL) AS shown, coalesce(sum(g.impressions),0) AS impressions, coalesce(sum(g.clicks),0) AS clicks
        FROM ai_pages a LEFT JOIN gsc_pages g USING(url) GROUP BY 1 ORDER BY 4 DESC`);
      summary.gsc.by_topic = all(`SELECT a.topic, count(*) AS pages, sum(g.url IS NOT NULL) AS shown, coalesce(sum(g.impressions),0) AS impressions, coalesce(sum(g.clicks),0) AS clicks
        FROM ai_pages a LEFT JOIN gsc_pages g USING(url) GROUP BY 1 ORDER BY 4 DESC`);
    }
  }
  if (hasAi) {
    summary.ai = {
      page_types: all(`SELECT a.page_type, count(*) AS pages, round(avg(p.word_count)) AS words_avg, round(avg(p.link_score),1) AS link_score_avg,
        round(avg(a.title_fit),2) AS title_fit, round(avg(a.description_fit),2) AS description_fit, round(avg(a.answer_first),2) AS answer_first, round(avg(a.thin),2) AS thin
        FROM ai_pages a JOIN pages p USING(url) GROUP BY 1 ORDER BY 2 DESC`),
      topics: all('SELECT topic, count(*) AS pages, round(avg(p.link_score),1) AS link_score_avg FROM ai_pages a JOIN pages p USING(url) GROUP BY 1 ORDER BY 2 DESC'),
      intents: all('SELECT intent, count(*) AS pages FROM ai_pages GROUP BY 1 ORDER BY 2 DESC'),
      topic_by_type: all('SELECT topic, page_type, count(*) AS pages FROM ai_pages GROUP BY 1,2'),
      taxonomy: all('SELECT * FROM ai_taxonomy'),
      cannibalisation: all('SELECT a, b, round(p,2) AS p FROM ai_cannibal WHERE p >= 0.5 ORDER BY p DESC'),
      link_opportunities: all('SELECT source, phrase, target, round(p,2) AS p FROM ai_link_opps WHERE p >= 0.8 ORDER BY p DESC'),
    };
    if (hasGsc) {
      const sharedQueries = db.prepare('SELECT count(*) AS n FROM gsc_queries a JOIN gsc_queries b ON a.query=b.query WHERE a.url=? AND b.url=?');
      for (const c of summary.ai.cannibalisation) c.shared_google_queries = sharedQueries.get(c.a, c.b).n;
    }
  }
  if (hasRendered) summary.rendered = all('SELECT url, word_count, new_links, requests, transfer_kb, lcp_ms, cls, json_array_length(console_errors) AS js_errors, json_array_length(axe) AS axe_rules_failed FROM rendered');

  const report = renderReport(db, summary);
  summary.findings = one('SELECT count(*) FROM issues');
  return { summary, report };
}
