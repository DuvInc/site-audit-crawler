// What changed between two crawls of the same site, both analysed: pages added and gone, status,
// indexability, title, description, h1, canonical, word count, inlinks, and findings that appeared or
// were resolved. Writes compare.md and compare.json in the newer crawl's folder.
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openCrawlDb } from './db.mjs';

export function compare(oldDir, newDir) {

  const db = openCrawlDb(newDir);
  db.exec(`ATTACH '${resolve(oldDir, 'crawl.db').replace(/'/g, "''")}' AS old`);
  const all = (sql) => db.prepare(sql).all();
  const html = "internal=1 AND type='html'";
  const changed = (col) => all(`SELECT n.url, o.${col} AS before, n.${col} AS after FROM main.pages n JOIN old.pages o USING(url)
    WHERE n.internal=1 AND coalesce(n.${col},'') != coalesce(o.${col},'') ORDER BY n.url`);

  const out = {
    old: oldDir,
    new: newDir,
    pages_added: all(`SELECT url, status FROM main.pages WHERE ${html} AND url NOT IN (SELECT url FROM old.pages) ORDER BY url`),
    pages_removed: all(`SELECT url, status FROM old.pages WHERE ${html} AND url NOT IN (SELECT url FROM main.pages) ORDER BY url`),
    status: changed('status'),
    indexability: changed('indexability'),
    title: changed('title'),
    description: changed('description'),
    h1: changed('h1'),
    canonical: changed('canonical'),
    word_count: all(`SELECT n.url, o.word_count AS before, n.word_count AS after FROM main.pages n JOIN old.pages o USING(url)
      WHERE n.internal=1 AND o.word_count > 0 AND abs(n.word_count - o.word_count) * 5 > o.word_count ORDER BY n.url`),
    inlinks: all(`SELECT n.url, o.unique_inlinks AS before, n.unique_inlinks AS after FROM main.pages n JOIN old.pages o USING(url)
      WHERE n.internal=1 AND n.type='html' AND (abs(n.unique_inlinks - o.unique_inlinks) >= 5 OR (n.unique_inlinks = 0 AND o.unique_inlinks > 0)) ORDER BY n.url`),
    issues_by_control: all(`SELECT code, max(label) AS label, sum(o) AS before, sum(n) AS after FROM (
        SELECT code, label, 0 AS o, count(*) AS n FROM main.issues GROUP BY code
        UNION ALL SELECT code, label, count(*), 0 FROM old.issues GROUP BY code) GROUP BY code HAVING sum(o) != sum(n) ORDER BY sum(n) - sum(o) DESC`),
    issues_new: all(`SELECT code, url, detail FROM main.issues n WHERE NOT EXISTS (SELECT 1 FROM old.issues o WHERE o.code=n.code AND o.url=n.url) ORDER BY code, url`),
    issues_resolved: all(`SELECT code, url, detail FROM old.issues o WHERE NOT EXISTS (SELECT 1 FROM main.issues n WHERE o.code=n.code AND o.url=n.url) ORDER BY code, url`),
  };
  writeFileSync(join(newDir, 'compare.json'), JSON.stringify(out, null, 2));

  const md = [`# Changes between ${oldDir} and ${newDir}`, ''];
  const section = (title, rows, line) => {
    md.push(`## ${title} (${rows.length})`, '');
    for (const r of rows.slice(0, 40)) md.push(`- ${line(r)}`);
    if (rows.length > 40) md.push(`- and ${rows.length - 40} more, see compare.json`);
    md.push('');
  };
  const diff = (r) => `${r.url} : ${r.before ?? 'nothing'} → ${r.after ?? 'nothing'}`;
  section('Pages added', out.pages_added, (r) => `${r.url} (${r.status})`);
  section('Pages gone', out.pages_removed, (r) => r.url);
  section('Status code', out.status, diff);
  section('Indexability', out.indexability, diff);
  section('Title', out.title, diff);
  section('Meta description', out.description, diff);
  section('H1', out.h1, diff);
  section('Canonical', out.canonical, diff);
  section('Word count (more than 20 %)', out.word_count, diff);
  section('Inlinks', out.inlinks, diff);
  section('Controls whose count moved', out.issues_by_control, (r) => `${r.label} : ${r.before} → ${r.after}`);
  section('New findings', out.issues_new, (r) => `${r.code} : ${r.url}${r.detail ? ` (${String(r.detail).slice(0, 100)})` : ''}`);
  section('Resolved findings', out.issues_resolved, (r) => `${r.code} : ${r.url}`);
  writeFileSync(join(newDir, 'compare.md'), md.join('\n'));
  db.close();
  return out;
}
