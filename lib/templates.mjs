// Templates: the pages of one layout, found from the crawl alone. A site of 10,000 URLs has a few dozen;
// structured data, and most fixes, are decided once per template. No Node import: runs on any handle.
//
// A template is a path shape (the first segment kept, the deeper ones as *: /blog/a and /blog/b are
// both /blog/*, and /fr/blog/a too when the page is in French) split by the page's structure signature (extract.mjs, struct_sig), so a section that
// mixes two layouts gives two templates. Each comes with a few sample pages and how many of its pages
// show each kind of field, which is what a role (article, product, location) is decided from.

/**
 * /blog/2024/my-post -> /blog/*\/*, / -> /, /about -> /about; query strings ignored. A first segment
 * that is the page's own language (/fr/blog/x on a page in fr) is dropped: the translations of a page
 * are one template. Only when it matches the page's lang, so /vs/x stays /vs/*.
 */
export function pathShape(url, lang = null) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return '/';
  }
  let segs = path.split('/').filter(Boolean);
  const own = (lang ?? '').toLowerCase().split('-')[0];
  if (segs.length && own && segs[0].toLowerCase().split(/[-_]/)[0] === own && /^[a-z]{2}([-_][a-z]{2})?$/i.test(segs[0])) segs = segs.slice(1);
  if (!segs.length) return '/';
  return '/' + segs.map((s, i) => (i === 0 ? s.toLowerCase() : '*')).join('/');
}

const FIELDS = ['times', 'prices', 'addresses', 'authors', 'phones', 'breadcrumb'];

/**
 * Every template of the crawl, the biggest first: its shape, signature, page count, up to `samples`
 * pages (the most linked), how many pages show each field, and the JSON-LD types already on them.
 * A shape of one page stays its own template (the home page, the about page).
 */
export function templatesOf(db, { samples = 3, max = 200 } = {}) {
  const groups = new Map();
  const rows = db
    .prepare("SELECT url, lang, struct_sig, field_evidence, schema_types, text_cut, coalesce(link_score, 0) AS link_score FROM pages WHERE internal = 1 AND type = 'html' AND status = 200")
    .all();
  for (const r of rows) {
    const shape = pathShape(r.url, r.lang);
    const lang = (r.lang ?? '').toLowerCase().split('-')[0] || null;
    const key = `${shape} ${r.struct_sig ?? 'unknown'}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { shape, struct_sig: r.struct_sig ?? null, pages: 0, cut: 0, langs: new Set(), sample: [], fields: Object.fromEntries(FIELDS.map((f) => [f, 0])), paths: Object.fromEntries(FIELDS.map((f) => [f, new Map()])), schema_types: {} }));
    g.pages++;
    if (lang) g.langs.add(lang);
    if (r.text_cut) g.cut++;
    g.sample.push({ url: r.url, link_score: r.link_score });
    if (g.sample.length > samples) g.sample.sort((a, b) => b.link_score - a.link_score).pop();
    let ev = null;
    try {
      ev = r.field_evidence ? JSON.parse(r.field_evidence) : null;
    } catch {}
    for (const f of FIELDS) {
      if (!ev?.[f]) continue;
      g.fields[f]++;
      // Each path counted once per page: where the template shows this field.
      for (const path of new Set([].concat(ev[f]).map((x) => x.path).filter(Boolean))) g.paths[f].set(path, (g.paths[f].get(path) ?? 0) + 1);
    }
    let types = [];
    try {
      types = r.schema_types ? JSON.parse(r.schema_types) : [];
    } catch {}
    for (const t of types) g.schema_types[t] = (g.schema_types[t] ?? 0) + 1;
  }
  return [...groups.values()]
    .sort((a, b) => b.pages - a.pages || a.shape.localeCompare(b.shape))
    .slice(0, max)
    .map((g) => ({
      shape: g.shape,
      struct_sig: g.struct_sig,
      pages: g.pages,
      langs: [...g.langs].sort(),
      // Pages whose stored text was cut: a field not found there is unknown, not missing.
      pages_cut: g.cut,
      samples: g.sample.sort((a, b) => b.link_score - a.link_score).map((s) => s.url),
      fields: g.fields,
      // The element that shows each field on the most pages, and on how many: a field at the same place
      // on most pages is the template's; scattered ones are mentions in the text.
      paths: Object.fromEntries(FIELDS.filter((f) => g.paths[f].size).map((f) => {
        const [path, pages] = [...g.paths[f]].sort((a, b) => b[1] - a[1])[0];
        return [f, { path, pages }];
      })),
      schema_types: g.schema_types,
    }));
}
