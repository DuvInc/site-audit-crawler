# Contributing

Thanks for looking. This is a one-person project maintained on a best-effort basis, so the most
useful thing you can do before writing code is open an issue. A small fix is always welcome; a large
one is worth agreeing on first.

## Getting set up

Node 22.13 or newer.

```bash
npm install
npm test        # no key, no network beyond localhost, no cost
```

`npm test` crawls a fixture site with planted defects on localhost (`test/fixture-site.mjs`) and
runs Search Console and the AI layer against fakes. If it does not pass on a fresh clone, that is a
bug worth reporting on its own.

To run it on a real site, see the README. Crawl sites you are allowed to crawl.

## Sign your commits off

Every commit needs a `Signed-off-by` line, which certifies that you wrote the patch or otherwise
have the right to submit it under the MIT licence. This is the
[Developer Certificate of Origin](https://developercertificate.org): one line, no paperwork, no
copyright assignment.

```bash
git commit -s -m "Your message"
```

## What makes a change likely to be merged

**A rule comes with its planted case.** Add the defect to `test/fixture-site.mjs`, on a page of
its own if you can, and assert in `test/audit.test.mjs` that the rule fires there and only there. A
rule that also fires on the clean home page is a false positive until proven otherwise.

**A threshold comes with its source.** Add it to `docs/thresholds.md` with the level of confidence
(Google's documentation, web.dev, a measurement, research, an industry study, or a convention).

**The purity boundary holds.** `lib/` reads no environment variable and prints nothing; the outside
services are injected (`fetch`, the Search Console transport, the model client). That is what keeps
the library embeddable and the tests free.

**Prompts are stable.** The chat prompts and decision questions are part of the AI cache key:
changing them makes every user's next run pay again. Say so in the pull request, with what the
change buys.

**Report what you measured.** For a crawler or AI change, give the site size, the time, the cost and
what changed in the findings.

**No new dependency without an issue first.** **Comments explain why, not what.** **No em dashes.**

## Reporting a bug

Include the commit, the Node version, the command, and the few lines of output or `summary.json`
around the problem. Never attach a `crawl.db` or Search Console data of a site that is not yours.

For anything with security implications, read [SECURITY.md](./SECURITY.md) instead of opening a
public issue.
