# Security policy

## Reporting a vulnerability

Please report privately rather than in a public issue, using GitHub's
[private vulnerability reporting](https://github.com/DuvInc/site-audit-crawler/security/advisories/new)
on this repository.

This is a one-person project. You should get an acknowledgement within a few days; if a week passes
with no reply, feel free to nudge by opening a public issue that says only that you are waiting on a
private report, with no details.

## What is in scope

- **Credentials.** Anything that causes `OPENROUTER_API_KEY`, `GSC_ACCESS_TOKEN`, a service account
  key or a token obtained from it to be printed, written to `crawl.db`, `summary.json`, `report.md` or
  the AI cache, sent to a model, or sent anywhere other than OpenRouter and Google.
- **Untrusted pages.** Every crawled page is untrusted text. It is parsed by cheerio, stored, shown in
  a Markdown report, and part of it is sent to a model. Text that makes the tool do something it
  should not (write outside the crawl folder, fetch something it was not asked to, run code) is in
  scope. Text that only biases a model's judgment is a known limit: the model returns typed answers
  or a fixed JSON shape, never instructions the tool follows.
- **The rendering step.** It opens pages in a real Chrome with JavaScript on. A way for a crawled
  page to reach the machine beyond what a normal visit allows is in scope.
- **The limits.** `--max` and the AI `--budget` are meant to hold. A way past them is in scope.

## What is out of scope

- Google, treg, OpenRouter and the model providers. Report those to their operators.
- Findings that are wrong. Audits are leads; the README says to check before acting.
- A problem that needs the attacker to already run code as you or have commit access.

## If you run this on sites

- **Crawl only what you are allowed to.** The crawler respects robots.txt and says who it is in its
  user-agent; keep it that way.
- **Keep audits out of repositories.** `audits/` holds what sites answered and Search Console data.
  It is gitignored here.
- **Keep the service account key outside the project folder**, and give it read access to the
  properties it needs only.

## If you forked this tool

Replace the link above with your own repository. This file arrived with the code and points at
somebody else's advisories.
