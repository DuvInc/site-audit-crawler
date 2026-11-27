#!/usr/bin/env node
// The command line. Reads the environment (and a .env in the current folder), builds the transports,
// and calls lib/. Everything else lives in lib/, which never reads the environment.

// node:sqlite still prints an ExperimentalWarning on Node 22: hide that one, keep the others.
// Set before lib/ is imported, hence the dynamic imports below.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w.stack ?? String(w));
});

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HELP = `site-audit: crawl a website into SQLite and audit it.

  site-audit run <url> [options]       crawl, analyse, render a sample, then Search Console and AI if asked
  site-audit crawl <url> [options]     only the crawl
  site-audit analyze <dir>             rules, summary.json and report.md
  site-audit render <dir>              one page per template in Chrome: JS diff, axe-core, LCP, CLS
  site-audit gsc <dir>                 join Google Search Console data
  site-audit ai <dir>                  the AI layer (OpenRouter, paid, cached, capped)
  site-audit compare <old> <new>       what changed between two analysed crawls
  site-audit llms <dir>                a draft llms.txt from the crawl, and the site's own file checked

Crawl     --max 5000  --concurrency 5  --include <regex>  --exclude <regex>  --no-external
          --user-agent <string>  --out <folder, default audits>  --dir <exact crawl folder>
Run       --no-render  --gsc google|treg  --ai
Render    --sample 20                         (Chrome: installed Google Chrome, or CHROME_PATH)
GSC       --gsc google|treg  --days 90  --inspect 40  --property sc-domain:example.com
          google: GSC_ACCESS_TOKEN, or GOOGLE_APPLICATION_CREDENTIALS (service account key file)
          treg:   treg connections connect --provider google-search-console
AI        --budget 0.5 (a hard cap: never exceeded)  --pilot 5  --dry (prints the worst case)
          --ai-include <regex>  --ai-exclude <regex> (which pages the models see)
          --chat-tier flex|normal (flex: half price, slower)  --steps taxonomy,pages,queries,cannibal,links
          --decision-model typesafe/jev-1.13  --chat-model openai/gpt-6-luna
          OPENROUTER_API_KEY (and optionally OPENROUTER_BASE_URL)
`;

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const opt = (name, def) => (has(name) ? argv[argv.indexOf(`--${name}`) + 1] : def);
const valued = new Set(['ai-include', 'ai-exclude', 'chat-tier', 'max', 'concurrency', 'include', 'exclude', 'user-agent', 'out', 'dir', 'gsc', 'sample', 'days', 'inspect', 'property', 'budget', 'pilot', 'steps', 'decision-model', 'chat-model']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && valued.has(argv[i - 1].slice(2))));
const [command, ...args] = positional;

if (!command || has('help') || command === 'help') {
  console.log(HELP);
  process.exit(command ? 0 : 1);
}
// A real environment variable always wins over .env.
if (existsSync('.env')) process.loadEnvFile('.env');

const lib = {
  crawl: () => import('../lib/crawl.mjs'),
  analyze: () => import('../lib/analyze.mjs'),
  render: () => import('../lib/render.mjs'),
  gsc: () => import('../lib/gsc.mjs'),
  google: () => import('../lib/google.mjs'),
  treg: () => import('../lib/treg.mjs'),
  ai: () => import('../lib/ai.mjs'),
  openrouter: () => import('../lib/openrouter.mjs'),
  compare: () => import('../lib/compare.mjs'),
  llms: () => import('../lib/llms-txt.mjs'),
  db: () => import('../lib/db.mjs'),
};
const log = (s) => console.log(s);

function crawlDirFor(url) {
  if (opt('dir')) return resolve(opt('dir'));
  const host = new URL(url).hostname.replace(/^www\./, '');
  return resolve(opt('out', 'audits'), host, new Date().toISOString().slice(0, 10));
}

async function doCrawl(url) {
  const { crawl } = await lib.crawl();
  const dir = crawlDirFor(url);
  const r = await crawl({
    start: url,
    dir,
    max: Number(opt('max', 5000)),
    concurrency: Number(opt('concurrency', 5)),
    external: !has('no-external'),
    include: opt('include') ? new RegExp(opt('include')) : undefined,
    exclude: opt('exclude') ? new RegExp(opt('exclude')) : undefined,
    ...(opt('user-agent') ? { userAgent: opt('user-agent'), robotsToken: opt('user-agent') } : {}),
    onProgress: ({ done, queued }) => log(`${done} done, ${queued} queued`),
  });
  log(`${r.urls} URLs in ${r.seconds} s (${r.fromLinks} from links, ${r.urls - r.fromLinks} only in sitemaps, ${r.skipped} skipped over --max) -> ${dir}`);
  return dir;
}

async function doAnalyze(dir) {
  const { analyze } = await lib.analyze();
  const s = analyze(dir);
  log(`${s.issues.length} controls with findings out of ${s.rules_run} run, ${s.findings} findings -> ${join(dir, 'report.md')}, summary.json`);
}

async function doRender(dir) {
  const { render } = await lib.render();
  await render(dir, { sample: Number(opt('sample', 20)), chromePath: process.env.CHROME_PATH, onPage: log });
}

async function gscTransport(source) {
  if (source === 'treg') return (await lib.treg()).tregTransport();
  if (source !== 'google') throw new Error('--gsc takes google or treg');
  const { googleTransport } = await lib.google();
  if (process.env.GSC_ACCESS_TOKEN) return googleTransport({ accessToken: process.env.GSC_ACCESS_TOKEN });
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!file) throw new Error('Search Console through Google needs GSC_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS (see README).');
  return googleTransport({ serviceAccount: JSON.parse(readFileSync(file, 'utf8')) });
}

async function doGsc(dir, source) {
  const { importSearchConsole } = await lib.gsc();
  const r = await importSearchConsole(dir, {
    transport: await gscTransport(source),
    source,
    property: opt('property'),
    days: Number(opt('days', 90)),
    inspect: Number(opt('inspect', 40)),
    onWarning: (w) => console.warn(`  ${w}`),
  });
  log(`${r.property}, ${r.startDate} to ${r.endDate}: ${r.total.clicks} clicks, ${r.total.impressions} impressions (no dimension); ${r.pages} pages with impressions, ${r.inspected} URL(s) inspected`);
}

async function doAi(dir) {
  const { runAi, AI_DEFAULTS } = await lib.ai();
  const dry = has('dry');
  const or = await lib.openrouter();
  const baseUrl = process.env.OPENROUTER_BASE_URL ? { baseUrl: process.env.OPENROUTER_BASE_URL } : {};
  const client = dry ? null : or.openRouterClient({
    apiKey: process.env.OPENROUTER_API_KEY,
    ...(process.env.OPENROUTER_BASE_URL ? { baseUrl: process.env.OPENROUTER_BASE_URL } : {}),
  });
  const r = await runAi(dir, {
    client,
    pricing: client ?? or.openRouterPricing(baseUrl),
    dry,
    chatTier: opt('chat-tier', AI_DEFAULTS.chatTier),
    budget: Number(opt('budget', AI_DEFAULTS.budget)),
    pilot: Number(opt('pilot', 0)),
    include: opt('ai-include') ? new RegExp(opt('ai-include')) : undefined,
    exclude: opt('ai-exclude') ? new RegExp(opt('ai-exclude')) : undefined,
    steps: opt('steps') ? opt('steps').split(',') : AI_DEFAULTS.steps,
    decisionModel: opt('decision-model', AI_DEFAULTS.decisionModel),
    chatModel: opt('chat-model', AI_DEFAULTS.chatModel),
    onLog: log,
  });
  log(dry
    ? `AI (dry): at most $${r.worstCase.toFixed(4)} for what is not cached yet, nothing sent`
    : `AI: $${r.spent.toFixed(4)} this run (hard cap $${opt('budget', AI_DEFAULTS.budget)}), $${r.spentAllRuns.toFixed(4)} over every run that shares the cache`);
}

const need = (v, what) => {
  if (!v) {
    console.error(`Missing ${what}.\n\n${HELP}`);
    process.exit(1);
  }
  return v;
};

try {
  switch (command) {
    case 'run': {
      const url = need(args[0], 'a URL');
      const dir = await doCrawl(url);
      await doAnalyze(dir);
      if (!has('no-render')) {
        try {
          await doRender(dir);
        } catch (e) {
          console.warn(`Rendering skipped: ${e.message}`);
        }
      }
      // A failed optional step should not cost the audit: warn, and analyse what there is.
      if (opt('gsc')) await doGsc(dir, opt('gsc')).catch((e) => console.warn(`Search Console skipped: ${e.message}`));
      if (has('ai')) await doAi(dir).catch((e) => console.warn(`AI layer stopped: ${e.message}`));
      if (opt('gsc') || has('ai') || !has('no-render')) await doAnalyze(dir);
      log(`\nRead first: ${join(dir, 'summary.json')} (agents) or ${join(dir, 'report.md')} (people). Query everything in ${join(dir, 'crawl.db')}.`);
      break;
    }
    case 'crawl':
      await doCrawl(need(args[0], 'a URL'));
      break;
    case 'analyze':
      await doAnalyze(resolve(need(args[0], 'a crawl folder')));
      break;
    case 'render':
      await doRender(resolve(need(args[0], 'a crawl folder')));
      break;
    case 'gsc':
      await doGsc(resolve(need(args[0], 'a crawl folder')), need(opt('gsc', process.env.GSC_SOURCE), '--gsc google or --gsc treg'));
      break;
    case 'ai':
      await doAi(resolve(need(args[0], 'a crawl folder')));
      break;
    case 'llms': {
      const dir = resolve(need(args[0], 'a crawl folder'));
      const [{ draftLlmsTxt, checkLlmsTxt }, { openCrawlDb, readMeta }] = await Promise.all([lib.llms(), lib.db()]);
      const db = openCrawlDb(dir);
      try {
        const draft = draftLlmsTxt(db);
        const { writeFileSync } = await import('node:fs');
        writeFileSync(join(dir, 'llms.txt'), draft.text);
        log(`Draft: ${draft.links} links (${draft.markdown_links} to Markdown copies) of ${draft.eligible_pages} pages in ${draft.lang ?? 'the main language'} -> ${join(dir, 'llms.txt')}`);
        const origin = new URL(readMeta(db).start_url).origin;
        const res = await fetch(`${origin}/llms.txt`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
        if (!res?.ok) {
          log(`${origin}/llms.txt: ${res ? res.status : 'no answer'}`);
          break;
        }
        const c = checkLlmsTxt(db, await res.text());
        const by = Object.groupBy(c.links, (l) => l.verdict);
        log(`${origin}/llms.txt: ${c.links.length} links (${Object.entries(by).map(([k, v]) => `${v.length} ${k}`).join(', ')}), ${c.problems.length} problems, ${c.missing.length} important pages missing`);
        for (const p of c.problems) log(`  line ${p.line ?? '-'}: ${p.message}`);
        for (const l of c.links.filter((x) => !['ok', 'markdown', 'external'].includes(x.verdict))) log(`  ${l.verdict}: ${l.url}`);
        for (const m of c.missing) log(`  missing: ${m.url}`);
      } finally {
        db.close();
      }
      break;
    }
    case 'compare': {
      const { compare } = await lib.compare();
      const out = compare(resolve(need(args[0], 'the older crawl folder')), resolve(need(args[1], 'the newer crawl folder')));
      log(Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k} ${v.length}`).join(', '));
      break;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      process.exit(1);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
