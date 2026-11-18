---
name: site-audit
description: Audit a website's technical SEO, indexability, internal links, structured data, speed, AI readiness and Search Console performance with site-audit-crawler, then report findings that were checked. Use when asked to audit, crawl or review a website, find broken links or redirect chains, check hreflang, canonicals or sitemaps, find pages close to Google's first page, find cannibalisation or internal links to add. Not for backlinks, rank tracking or sites you are not allowed to crawl.
---

# Site audit

## Run

```bash
node bin/site-audit.mjs run https://example.com                 # free: crawl, rules, Chrome sample
node bin/site-audit.mjs run https://example.com --gsc treg      # or --gsc google: adds Search Console
node bin/site-audit.mjs run https://example.com --ai --budget 0.10   # adds the AI layer, paid
```

- Ask before `--ai`: it spends money (about $0.06 for 250 pages, measured). Say the number of indexable pages and the budget. `--dry` costs nothing and shows the requests.
- A large site: start with `--max 2000`, or `--include '^https://example.com/blog/'`.
- Output: `audits/<host>/<date>/summary.json`, `report.md`, `crawl.db`.

## Read

1. `summary.json` first: `issues` is sorted by priority (high, medium, low), then kind (issue, warning, opportunity), with counts and five examples each. `sections` shows where problems concentrate. `gsc.potential` ranks pages by clicks to gain.
2. Dig in `crawl.db` with SQL rather than rerunning anything:

```sql
SELECT url, detail FROM issues WHERE code = 'internal_4xx';
SELECT l.src, l.anchor, l.position FROM links l WHERE l.dst = 'https://example.com/broken' AND l.type = 'hyperlink';
SELECT url, title, word_count, link_score, unique_inlinks, depth FROM pages WHERE internal = 1 AND indexable = 1 ORDER BY link_score LIMIT 20;
```

3. Thresholds and their sources: `docs/thresholds.md`. Say when a finding rests on a convention (section F) rather than on Google's documentation.

## Before you report

- **Check each high finding yourself** (fetch the page, or query the links). A broken external link may only refuse the crawler's user-agent: retry with a browser user-agent before calling it dead.
- **AI scores are leads, not facts.** Read the cannibalisation pairs and the link proposals before recommending them. Above 0.8, most link proposals were right in the author's reading; between 0.55 and 0.7, almost none.
- **Name the provenance of every Search Console number**: property, window, and whether it is the total without dimension (`gsc.total`) or a per-page figure (trimmed by Google).
- **Lab speed is not field speed.** LCP and CLS come from one load in a local Chrome.
- Group findings by what fixes them (one template, one redirect rule), not by control.
