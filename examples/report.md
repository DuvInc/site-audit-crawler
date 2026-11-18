> This is the audit of `test/fixture-site.mjs`, a small site with planted defects served on localhost: the HTTP and localhost findings come from that. Regenerate with `npm run example`.

# Site audit: localhost

Crawled on 2026-01-01: 21 URLs in 1 s (20 internal, 1 external). Every line below comes from a query on `crawl.db`; thresholds and their sources are in `docs/thresholds.md` of site-audit-crawler.

## Overview

| Internal HTML pages | Indexable | Words (median) | TTFB (median) | HTML (median) |
| --- | --- | --- | --- | --- |
| 12 | 9 | 226 | 0 ms | 1 kB |

| Indexability | Pages |
| --- | --- |
| Indexable | 9 |
| Noindex | 1 |
| Client error | 1 |
| Canonicalised | 1 |

| Depth (clicks from the start URL) | Pages |
| --- | --- |
| not linked | 1 |
| 0 | 1 |
| 1 | 9 |

| Status code | Internal | External |
| --- | --- | --- |
| blocked | 1 | 0 |
| 200 | 13 | 0 |
| 301 | 3 | 0 |
| 302 | 1 | 0 |
| 307 | 1 | 0 |
| 404 | 1 | 1 |

## Findings

50 controls with findings, out of 121 run.

| Priority | Category | Control | URLs | Examples |
| --- | --- | --- | --- | --- |
| high | Security | HTTP URLs | 20 | /<br>/about |
| high | Links | Outlinks to localhost | 16 | / (http://127.0.0.1:4321/gone)<br>/about (/) |
| high | Content | Exact duplicates | 2 | /dup-a (4e9c52932b14cb78b7a26c485358d21b13024e30)<br>/dup-b (4e9c52932b14cb78b7a26c485358d21b13024e30) |
| high | Response codes | Internal redirect loop | 2 | /loop-a (/loop-a -> /loop-b)<br>/loop-b (/loop-b -> /loop-a) |
| high | Hreflang | Missing return links | 1 | /en/ (fr: /fr/) |
| high | Response codes | Internal client error (4xx) | 1 | /missing (1 source page(s), e.g. /) |
| high | Canonicals | Canonicalised | 1 | /canonicalised (/about) |
| high | Content | Lorem ipsum placeholder | 1 | /about |
| high | Directives | Noindex | 1 | /noindex-page (noindex ) |
| high | Response codes | Internal blocked by robots.txt | 1 | /private/secret (1 source page(s), e.g. /) |
| medium | Sitemaps | Indexable URLs not in sitemap | 6 | /blog/post-1<br>/dup-a |
| medium | H1 | Missing | 1 | /about |
| medium | Sitemaps | Non-indexable URLs in sitemap | 1 | /noindex-page (Noindex) |
| medium | Sitemaps | Orphan URLs (in a sitemap, reached by no internal link) | 1 | /orphan |
| medium | Canonicals | Missing | 8 | /about<br>/blog/post-1 |
| medium | Response codes | Internal temporary redirect (302, 303, 307): a weak signal, Google keeps the old URL | 2 | /older-page (302 -> /about)<br>/temp (307 -> /team) |
| medium | AI readiness | AI crawlers disallowed in robots.txt | 1 | / (GPTBot) |
| medium | Response codes | Internal redirect chain | 1 | /old-page (/old-page -> /older-page -> /about) |
| medium | Page titles | Duplicate | 2 | /about (About us)<br>/team (About us) |
| medium | Content | Title names a past year | 1 | /blog/post-1 (The 2019 guide to widgets) |
| medium | Images | Over 100 kB | 1 | /img/big.png (120 kB) |
| low | Images | Missing alt attribute | 1 | / (1 image(s), e.g. /img/big.png) |
| low | Security | Missing Content-Security-Policy header | 11 | /<br>/about |
| low | Security | Missing secure Referrer-Policy header | 11 | /<br>/about |
| low | Security | Missing X-Content-Type-Options header | 11 | /<br>/about |
| low | Security | Missing X-Frame-Options header | 11 | /<br>/about |
| low | H2 | Missing | 8 | /about<br>/blog/post-1 |
| low | Response codes | Internal links to a redirect (3xx) | 3 | /loop-a (1 source page(s), e.g. /)<br>/old-page (1 source page(s), e.g. /) |
| low | Response codes | External client error (4xx) | 1 | http://127.0.0.1:4321/gone (1 source page(s), e.g. /) |
| low | Hreflang | Missing x-default | 1 | /fr/ |
| low | Social | Missing X cards | 9 | /<br>/about |
| low | Social | Missing Open Graph tags | 8 | /about<br>/blog/post-1 |
| low | Structured data | Missing | 8 | /<br>/about |
| low | Page titles | Below 30 characters | 8 | /about (8: About us)<br>/blog/post-1 (25: The 2019 guide to widgets) |
| low | Links | Fewer than 5 pages link to it (Zyppy study: the group with the fewest Google clicks) | 6 | /blog/post-1 (1 linking page(s), link score 35.6)<br>/dup-a (1 linking page(s), link score 35.6) |
| low | Page titles | Below 200 pixels (estimated) | 6 | /about (82 px: About us)<br>/dup-a (106 px: Duplicate A) |
| low | Meta description | Below 70 characters | 3 | /dup-a (69: First of two pages with the same body text, to test exact duplicates.)<br>/fr/ (67: La version française de la page des widgets de test, avec son lien.) |
| low | H1 | Duplicate | 2 | /dup-a (Same)<br>/dup-b (Same) |
| low | AI readiness | No /llms.txt (optional: Google says it does not use it) | 1 | / (status 404, text/html) |
| low | AI readiness | Home page does not answer Accept: text/markdown with Markdown | 1 | / (text/html; charset=utf-8) |
| low | Meta description | Missing | 1 | /about |
| low | Directives | Article without max-image-preview:large (Google Discover asks for it to show a large image) | 1 | /blog/post-1 |
| low | AI readiness | Article with fewer than 3 figures (GEO study: adding statistics raised visibility in AI answers) | 1 | /blog/post-1 (565 words, 0 figure(s), 0 outside source(s)) |
| low | AI readiness | Article without a single link to an outside source (GEO study: citing sources raised visibility in AI answers) | 1 | /blog/post-1 (565 words, 0 figure(s)) |
| low | Images | PNG, JPEG or GIF over 100 kB (web.dev: prefer AVIF or WebP) | 1 | /img/big.png (image/png, 120 kB) |
| low | Images | Missing size attributes | 1 | / (1 image(s), e.g. /img/big.png) |
| low | Structured data | Rich result validation warnings (subset) | 1 | /blog/post-1 (Article without datePublished) |
| low | Structured data | Home page without WebSite structured data (name and url): the source Google prefers for the site name | 1 | / |
| low | Sitemaps | Sitemap URLs without lastmod | 1 | / (1 of 4 URLs) |
| low | Page titles | Same as h1 | 1 | /blog/post-1 (The 2019 guide to widgets) |

## Sections

| Section | Indexable pages | Words (avg) | Link score (avg) | Linking pages (avg) | Medium and high findings |
| --- | --- | --- | --- | --- | --- |
| (home) | 3 | 244 | 57.1 | 4.3 | 12 |
| about | 1 | 226 | 91.3 | 11 | 6 |
| blog | 1 | 565 | 35.6 | 1 | 5 |
| dup-a | 1 | 240 | 35.6 | 1 | 5 |
| dup-b | 1 | 240 | 35.6 | 1 | 5 |
| team | 1 | 231 | 91.3 | 11 | 5 |
| orphan | 1 | 220 | 0 | 0 | 4 |

## Readability for AI crawlers and agents

| Check | Result |
| --- | --- |
| /llms.txt | 404 text/html |
| /llms-full.txt | 404 text/html |
| Home page with a GPTBot user-agent | 200 |
| Home page with Accept: text/markdown | text/html; charset=utf-8 |
| AI crawlers named in robots.txt | 1 of 14 |
| AI crawlers disallowed | GPTBot |
| Pages that declare a Markdown version | 0 of 9 |

## Internal linking

Pages best served by internal links:

| Page | Link score | Linking pages | Depth |
| --- | --- | --- | --- |
| / | 100 | 11 | 0 |
| /about | 91.3 | 11 | 1 |
| /team | 91.3 | 11 | 1 |
| /blog/post-1 | 35.6 | 1 | 1 |
| /en/ | 35.6 | 1 | 1 |
| /fr/ | 35.6 | 1 | 1 |
| /dup-a | 35.6 | 1 | 1 |
| /dup-b | 35.6 | 1 | 1 |
| /orphan | 0 | 0 |  |

Indexable pages least served:

| Page | Link score | Linking pages | Depth |
| --- | --- | --- | --- |
| /orphan | 0 | 0 | not linked |
| /blog/post-1 | 35.6 | 1 | 1 |
| /en/ | 35.6 | 1 | 1 |
| /fr/ | 35.6 | 1 | 1 |
| /dup-a | 35.6 | 1 | 1 |
| /dup-b | 35.6 | 1 | 1 |
| /about | 91.3 | 11 | 1 |
| /team | 91.3 | 11 | 1 |
| / | 100 | 11 | 0 |

## Weight and speed

| Heaviest HTML | kB | Words | DOM nodes |
| --- | --- | --- | --- |
| /blog/post-1 | 4 | 565 | 17 |
| / | 2 | 292 | 36 |
| /en/ | 1 | 220 | 18 |
| /dup-b | 1 | 240 | 15 |
| /dup-a | 1 | 240 | 15 |
| /fr/ | 1 | 220 | 16 |
| /team | 1 | 231 | 15 |
| /noindex-page | 1 | 220 | 16 |
| /canonicalised | 1 | 220 | 16 |
| /orphan | 1 | 220 | 15 |

| Slowest responses | TTFB |
| --- | --- |
| /team | 1 ms |
| / | 0 ms |
| /about | 0 ms |
| /blog/post-1 | 0 ms |
| /noindex-page | 0 ms |
| /canonicalised | 0 ms |
| /en/ | 0 ms |
| /fr/ | 0 ms |
| /dup-a | 0 ms |
| /dup-b | 0 ms |

## Structured data

| Type | Pages |
| --- | --- |
| Person | 1 |
| Article | 1 |
