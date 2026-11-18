// Regenerate examples/: the report and summary of the fixture site (test/fixture-site.mjs), crawled
// on a fixed port so the files do not change from one run to the next. No network beyond localhost.
//   npm run example
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureSite } from './fixture-site.mjs';
import { crawl } from '../lib/crawl.mjs';
import { analyze } from '../lib/analyze.mjs';

const site = await startFixtureSite({ port: 4321 });
const root = mkdtempSync(join(tmpdir(), 'site-audit-example-'));
try {
  const dir = join(root, 'localhost', '2026-01-01');
  await crawl({ start: `${site.origin}/`, dir });
  analyze(dir);
  // Dates and timings change on every run; the example keeps fixed ones.
  const stable = (s) => s.replace(/Crawled on \d{4}-\d{2}-\d{2}: (\d+) URLs in \d+ s/, 'Crawled on 2026-01-01: $1 URLs in 1 s').replace(/"crawled_at": "[^"]+"/, '"crawled_at": "2026-01-01T00:00:00.000Z"');
  const note = '> This is the audit of `test/fixture-site.mjs`, a small site with planted defects served on localhost: the HTTP and localhost findings come from that. Regenerate with `npm run example`.\n\n';
  writeFileSync('examples/report.md', note + stable(readFileSync(join(dir, 'report.md'), 'utf8')));
  writeFileSync('examples/summary.json', stable(readFileSync(join(dir, 'summary.json'), 'utf8')));
  console.log('examples/report.md and examples/summary.json written');
} finally {
  await site.close();
  rmSync(root, { recursive: true, force: true });
}
