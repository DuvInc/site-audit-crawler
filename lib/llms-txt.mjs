// llms.txt (https://llmstxt.org): read a site's file and say what is wrong with it, and draft one from
// the crawl. The format: an H1 with the site's name (the only required part), an optional blockquote
// summary and paragraphs, then H2 sections of link lists, "- [name](url): notes", the section named
// "Optional" holding what an agent may skip.
//
// What it is worth, said plainly: no major assistant has committed to reading it, and Google says it
// has no effect on Search. It costs nothing to publish and helps the agents that do look for it; a
// Markdown copy of each page does more. No Node import: runs on any database handle.
import { hasTable } from './schema.mjs';
import { roleOf } from './schema-plan.mjs';
import { pathShape, templatesOf } from './templates.mjs';

/** The H2 sections a draft uses, in order, and the roles each one lists. */
export const LLMS_SECTIONS = [
  { name: 'Product', roles: ['pricing', 'product', 'service', 'tool'] },
  { name: 'Docs', roles: ['docs'] },
  { name: 'Comparisons', roles: ['comparison'] },
  { name: 'Articles', roles: ['article'] },
  { name: 'Events', roles: ['event'] },
  { name: 'Company', roles: ['about', 'contact', 'location', 'profile', 'job'] },
  { name: 'Pages', roles: ['other'] },
  { name: 'Optional', roles: ['listing', 'legal'] },
];
// A section of one template can hold hundreds of pages: the most read and most linked ones speak for it.
const ROLE_CAP = { article: 12, docs: 15, comparison: 8, profile: 5, job: 5, event: 8, other: 12, listing: 6, legal: 6 };
const OPTIONAL_MAX = 10;

const LINK = /^\[([^\]]*)\]\(([^)\s]+)\)\s*(?::\s*(.*))?$/;

/**
 * Reads an llms.txt. Problems: `html` (a web page came back, often a catch-all route), `no_title`,
 * `several_titles`, `item_without_link` (a list item of a section that is not "[name](url)"),
 * `relative_link`, `no_links`. Only the first two make the file unusable.
 */
export function parseLlmsTxt(raw) {
  const text = String(raw ?? '').replace(/^﻿/, '');
  const problems = [];
  if (/^\s*<(!doctype|html|head|body)\b/i.test(text)) {
    return { title: null, summary: null, sections: [], links: [], problems: [{ code: 'html', line: 1, message: 'The address returns a web page, not Markdown: often a catch-all route that answers every path.' }] };
  }
  const lines = text.split(/\r?\n/);
  let title = null;
  let summary = null;
  const sections = [];
  let current = null;
  const firstLine = lines.findIndex((l) => l.trim());
  lines.forEach((line, i) => {
    const n = i + 1;
    const t = line.trim();
    if (/^#\s+/.test(t)) {
      if (title === null && i === firstLine) title = t.replace(/^#\s+/, '').trim();
      else problems.push({ code: 'several_titles', line: n, message: 'A second H1: the file has one, the site name, at the top.' });
      return;
    }
    if (/^##\s+/.test(t)) {
      const name = t.replace(/^##\s+/, '').trim();
      current = { name, optional: /^optional$/i.test(name), links: [] };
      sections.push(current);
      return;
    }
    if (!current) {
      if (summary === null && /^>\s?/.test(t)) summary = t.replace(/^>\s?/, '').trim();
      return;
    }
    const item = t.match(/^[-*+]\s+(.*)$/);
    if (!item) return;
    const m = item[1].match(LINK);
    if (!m) {
      problems.push({ code: 'item_without_link', line: n, message: 'A list item that does not start with a link "[name](url)".' });
      return;
    }
    const [, name, url, note] = m;
    if (!/^https?:\/\//i.test(url)) problems.push({ code: 'relative_link', line: n, message: `${url} is relative: an agent that reads the file alone cannot follow it.` });
    current.links.push({ title: name.trim(), url, note: note?.trim() || null, line: n, optional: current.optional });
  });
  if (title === null) problems.unshift({ code: 'no_title', line: firstLine + 1 || 1, message: 'The file must start with an H1 naming the site ("# Name"): it is the one required part.' });
  const links = sections.flatMap((s) => s.links);
  if (!links.length && title !== null) problems.push({ code: 'no_links', line: null, message: 'No link list: valid, but it gives an agent nothing to read next.' });
  return { title, summary, sections: sections.map((s) => ({ name: s.name, optional: s.optional, links: s.links.length })), links, problems };
}

const host = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return null;
  }
};
const trailing = (u) => (u.endsWith('/') ? u.slice(0, -1) : `${u}/`);
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
const mdText = (s) => s.replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')'));
const mdUrl = (u) => u.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');

/** The page's name: its title without the site's suffix ("Pricing | Acme" -> "Pricing"), else its H1. */
function nameOf(p, siteName) {
  let t = clean(p.title);
  if (siteName) t = t.replace(new RegExp(`\\s*[|·•\\-–—:]\\s*${siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '');
  if (t && t.length <= 90) return t;
  return clean(p.h1) || t || new URL(p.url).pathname;
}

/**
 * The pages a file for this site should list, by section, the most read (Search Console clicks when the
 * crawl has them) and most linked first, in the home page's language. Only pages that answer 200, are
 * indexable, are their own canonical and are no near copy. A page that declares a Markdown copy
 * (<link rel="alternate" type="text/markdown">) is listed by that copy, which agents read best.
 */
export function llmsCandidates(db, { max = 50 } = {}) {
  const gsc = hasTable(db, 'gsc_pages');
  const rows = db
    .prepare(
      `SELECT p.url, p.title, p.h1, p.description, p.og, p.lang, p.md_alternate, p.canonical, coalesce(p.link_score, 0) AS link_score, ${gsc ? 'coalesce(g.clicks, 0)' : '0'} AS clicks
       FROM pages p ${gsc ? 'LEFT JOIN gsc_pages g ON g.url = p.url' : ''}
       WHERE p.internal = 1 AND p.type = 'html' AND p.status = 200 AND coalesce(p.indexable, 1) = 1 AND p.near_dup_of IS NULL`
    )
    .all()
    .filter((r) => !r.canonical || r.canonical === r.url || trailing(r.canonical) === r.url);
  const home = rows.find((r) => new URL(r.url).pathname === '/') ?? null;
  const langOf = (r) => (r.lang ?? '').toLowerCase().split('-')[0] || null;
  const counts = new Map();
  for (const r of rows) if (langOf(r)) counts.set(langOf(r), (counts.get(langOf(r)) ?? 0) + 1);
  const lang = (home && langOf(home)) ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const inLang = rows.filter((r) => !lang || !langOf(r) || langOf(r) === lang);

  // Each page's role, from its template (the same rules as the structured data plan).
  const templates = templatesOf(db, { samples: 1, max: 400 });
  const shapes = templates.map((t) => t.shape);
  const roleByShape = new Map(templates.map((t) => [t.shape, roleOf(t, shapes).role]));
  const ranked = inLang
    .filter((r) => r !== home)
    .map((r) => ({ ...r, role: roleByShape.get(pathShape(r.url, r.lang)) ?? 'other' }))
    .sort((a, b) => b.clicks - a.clicks || b.link_score - a.link_score || a.url.localeCompare(b.url));

  const perRole = new Map();
  const picked = [];
  let main = 0;
  let optional = 0;
  for (const r of ranked) {
    const section = LLMS_SECTIONS.find((s) => s.roles.includes(r.role)) ?? LLMS_SECTIONS.find((s) => s.name === 'Pages');
    const isOptional = section.name === 'Optional';
    if (isOptional ? optional >= OPTIONAL_MAX : main >= max) continue;
    const n = perRole.get(r.role) ?? 0;
    if (n >= (ROLE_CAP[r.role] ?? max)) continue;
    perRole.set(r.role, n + 1);
    if (isOptional) optional++;
    else main++;
    picked.push({ url: r.url, link: r.md_alternate || r.url, markdown: Boolean(r.md_alternate), title: r.title, h1: r.h1, description: r.description, role: r.role, section: section.name, clicks: r.clicks, link_score: r.link_score });
  }
  return { home, lang, other_langs: rows.length - inLang.length, eligible: inLang.length - (home ? 1 : 0), pages: picked };
}

/**
 * A draft llms.txt from the crawl: the site's name, a one-line summary (given, else the home page's
 * meta description), and the candidate pages by section, each with its meta description as the note.
 */
export function draftLlmsTxt(db, { name = null, summary = null, max = 50 } = {}) {
  const c = llmsCandidates(db, { max });
  const ogName = (() => {
    try {
      return JSON.parse(c.home?.og ?? 'null')?.['og:site_name'] ?? null;
    } catch {
      return null;
    }
  })();
  const siteName = clean(name) || ogName || clean(c.home?.title).split(/\s[|·•\-–—]\s/)[0] || (c.home ? host(c.home.url) : 'Site');
  const line = clean(summary) || clean(c.home?.description) || null;
  const out = [`# ${siteName}`, ''];
  if (line) out.push(`> ${line}`, '');
  const sections = [];
  for (const s of LLMS_SECTIONS) {
    const pages = c.pages.filter((p) => p.section === s.name);
    if (!pages.length) continue;
    out.push(`## ${s.name}`, '');
    const links = pages.map((p) => {
      const title = cap(nameOf(p, siteName), 90);
      const desc = clean(p.description);
      const note = desc && desc.toLowerCase() !== title.toLowerCase() ? cap(desc, 200) : null;
      out.push(`- [${mdText(title)}](${mdUrl(p.link)})${note ? `: ${note}` : ''}`);
      return { title, url: p.link, page: p.url, note, role: p.role, markdown: p.markdown };
    });
    out.push('');
    sections.push({ name: s.name, links });
  }
  return {
    text: out.join('\n').trimEnd() + '\n',
    name: siteName,
    summary: line,
    lang: c.lang,
    sections,
    links: sections.reduce((n, s) => n + s.links.length, 0),
    markdown_links: c.pages.filter((p) => p.markdown).length,
    eligible_pages: c.eligible,
    other_lang_pages: c.other_langs,
  };
}

/**
 * The site's llms.txt read against the crawl: each link's fate (ok, markdown copy of a crawled page,
 * redirect, error, noindex, not_crawled, external) and the most important pages it leaves out.
 * `not_crawled` links are for the caller to fetch.
 */
export function checkLlmsTxt(db, raw, { max = 50 } = {}) {
  const parsed = parseLlmsTxt(raw);
  const byUrl = db.prepare('SELECT url, status, redirect_to, indexable, indexability, error FROM pages WHERE url = ? OR url = ?');
  const byMd = db.prepare('SELECT url FROM pages WHERE md_alternate = ? OR md_alternate = ? LIMIT 1');
  const anyRow = db.prepare('SELECT url FROM pages WHERE internal = 1 LIMIT 1').get();
  const own = anyRow ? host(anyRow.url) : null;
  const listed = new Set();
  const links = parsed.links.map((l) => {
    const base = { title: l.title, url: l.url, line: l.line, optional: l.optional };
    if (!/^https?:\/\//i.test(l.url)) return { ...base, verdict: 'relative' };
    if (own && host(l.url) !== own) return { ...base, verdict: 'external' };
    const md = byMd.get(l.url, trailing(l.url));
    if (md) {
      listed.add(md.url);
      return { ...base, verdict: 'markdown', page: md.url };
    }
    const p = byUrl.get(l.url, trailing(l.url));
    if (!p) {
      // The llmstxt.org convention: page.md is the Markdown copy of page. Counted as listed; the caller fetches it.
      const html = /\.md$/i.test(l.url) ? byUrl.get(l.url.replace(/(\/index)?\.md$/i, ''), l.url.replace(/(\/index)?\.md$/i, '/')) : null;
      if (html) listed.add(html.url);
      return { ...base, verdict: 'not_crawled', ...(html ? { page: html.url } : {}) };
    }
    listed.add(p.url);
    if (p.error || !p.status) return { ...base, verdict: 'error', detail: p.error ?? 'no answer' };
    if (p.status >= 300 && p.status < 400) return { ...base, verdict: 'redirect', status: p.status, to: p.redirect_to };
    if (p.status >= 400) return { ...base, verdict: 'error', status: p.status };
    if (p.indexable === 0) return { ...base, verdict: 'noindex', detail: p.indexability };
    return { ...base, verdict: 'ok' };
  });
  const missing = llmsCandidates(db, { max })
    .pages.filter((p) => p.section !== 'Optional' && !listed.has(p.url))
    .slice(0, 15)
    .map((p) => ({ url: p.url, section: p.section, clicks: p.clicks }));
  return { title: parsed.title, summary: parsed.summary, sections: parsed.sections, problems: parsed.problems, links, missing };
}
