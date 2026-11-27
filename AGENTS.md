# AGENTS.md

How to work in this repository. The README says what the tool does; this file says how not to break it.

## Layout

```
bin/site-audit.mjs    the CLI: reads the environment and .env, builds the transports, calls lib/
lib/
  core.mjs            everything that runs without Node (a Cloudflare Worker, Workflow or Durable Object)
  schema.mjs          the crawl database schema, the database-handle contract, tx()
  crawl-core.mjs      the crawler in resumable batches: robots.txt, sitemaps, AI-readiness probes, queue in SQLite
  crawl.mjs           the Node loop around crawl-core, writing <dir>/crawl.db
  extract.mjs         everything read from one HTML document (cheerio), raw or rendered
  robots.mjs          robots.txt parsing and matching (RFC 9309)
  structured-data.mjs the schema.org catalogue: types, fields, Google's levels, hints, builder, validator
  templates.mjs       the pages of one layout: path shape (translations together) split by structure signature
  db.mjs              node:sqlite: create and open <dir>/crawl.db
  durable-object-db.mjs  the database handle over a Durable Object's ctx.storage
  analyze-core.mjs    depth, inlinks, link score, indexability, duplicates, then every rule, on a handle
  analyze.mjs         analyze(dir): analyze-core, then summary.json and report.md
  report.mjs          report.md from the summary
  render.mjs          Chrome sample: raw vs rendered, axe-core, LCP, CLS (playwright-core, optional)
  gsc-core.mjs        Search Console import on a handle, transport injected, rows paged 25,000 at a time
  gsc.mjs             importSearchConsole(dir): gsc-core on <dir>/crawl.db
  google.mjs          transport: Google's API (service account JWT or access token)
  treg.mjs            transport: the treg CLI
  ai.mjs              the AI layer, client injected, cache, hard budget cap
  openrouter.mjs      the model client
  compare.mjs         two analysed crawls, what changed
  index.mjs           everything in one import
test/                 node:test, a fixture site on localhost, fake transports; no key, no internet
docs/thresholds.md    where every threshold comes from
examples/             the report of the fixture site (npm run example)
skills/site-audit/    the procedure for an agent that uses the tool
```

## Commands

```bash
npm install
npm test                                   # 85 tests, no key, no network beyond localhost
npm run example                            # regenerate examples/ from the fixture site
node bin/site-audit.mjs run <url>          # crawl, analyse, render; add --gsc google|treg and --ai
node bin/site-audit.mjs --help
```

## Rules

1. **`lib/` never reads the environment and never logs.** It takes options and callbacks (`onProgress`, `onLog`, `onWarning`). `bin/` reads `process.env` and prints.
2. **One file per outside service.** The crawl takes `fetch`; Search Console goes through a transport `(path, body?) => Promise<json>` (`google.mjs`, `treg.mjs`); models go through a client with `decide(body)` and `chat({ model, system, user, schema, maxTokens })` (`openrouter.mjs`). A new provider is a new file with the same contract, nothing else changes.
3. **A rule is one line in `RULES` when SQL can say it** (`[code, category, priority, kind, label, sql]`, the SQL returns `url, detail`). Only what needs a walk (redirect chains, hreflang pairs, Search Console curves) is code. Every new rule gets a planted case in `test/fixture-site.mjs` and an assertion.
4. **Every threshold is sourced in `docs/thresholds.md`, or listed there as a convention.** A threshold change cites what changed.
5. **The two chat prompts in `PROMPTS` (lib/ai.mjs) are part of the cache key.** Changing one byte makes the next run pay again for every page. The decision questions are part of the key too.
6. **The budget is a hard cap per run.** Each call reserves its worst case at the listed price before it is sent (`worstCase` in `lib/ai.mjs`: input as one token per two UTF-8 bytes plus 500, output at `max_tokens`, chat calls twice for the JSON retry, normal tier price even on Flex). A call billed above its reservation stops every further call. A new model call must reserve the same way; no call is sent without a known price. What was paid for stays in the cache.
7. **Search Console totals are read without dimension.** Never sum per-query or per-page rows to make a total.
8. **No new dependency without an issue first.** cheerio is the only hard one; playwright-core and axe-core are optional and loaded only by `render`.
9. **English, no em dashes, comments say why.**

## Things that bite

- **node:sqlite prints an ExperimentalWarning on Node 22.** `bin/` hides that one warning; scripts use `node --no-warnings`.
- **Internal means same host, `www.` ignored, port ignored.** That is why the test fixture uses `127.0.0.1` for "external" links: same server, another host name.
- **Redirects, robots-blocked URLs and connection errors have type `unknown`**, not `html`: they have no content type. Indexability covers them; the `html` view (`internal=1 AND type='html' AND status=200`) does not.
- **Images without a Content-Length are downloaded to be measured.** Other non-HTML files are not.
- **Text is the main content only**: `<main>` when the page has one, otherwise the body without header, nav, aside and footer. Word counts are lower than tools that count the whole body.
- **The Decisions API is in alpha.** If OpenRouter changes it, `lib/openrouter.mjs` is the one place to fix.
- **Rendering needs Chrome.** `run` skips it with a warning when Chrome cannot start; set `CHROME_PATH` for Chromium.
- **The AI cache lives next to the crawl folders** (`audits/<host>/ai-cache.db`), shared by every crawl of a host. That is what makes the second month cheap; delete it to start over.
