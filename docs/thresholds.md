# Thresholds and their sources

Where each threshold of the tool comes from, and how much weight it carries. Read in November 2026. A threshold without a source here is a convention, to be read as one.

Levels of confidence, from the firmest:

- **A. Google, official documentation**: what Google says it does.
- **B. web.dev and Chrome**: the Chrome team's thresholds, the ones Lighthouse applies.
- **C. Measurement of the web**: HTTP Archive, millions of pages measured.
- **D. Independent research**: a peer-reviewed paper, a polling institute.
- **E. Industry studies**: a tool vendor publishes its own data. Correlations, often one sample.
- **F. Conventions**: a common SEO tool default or a choice of this project, with no evidence.

## A. Google, official documentation

| What Google says | What the tool does with it |
| --- | --- |
| Googlebot reads the **first 2 MB** of an HTML, CSS or JS file, measured uncompressed, and 64 MB of a PDF. The rest is not indexed. ([Googlebot](https://developers.google.com/search/docs/crawling-indexing/googlebot)) | `validation_html_over_2mb`, high priority |
| Google's crawlers follow **up to 10 redirect hops**. 301 and 308 are a strong signal; **302, 303 and 307 a weak one**, the old URL stays in the results. ([HTTP status codes](https://developers.google.com/search/docs/crawling-indexing/http-network-errors), [redirects](https://developers.google.com/search/docs/crawling-indexing/301-redirects)) | `redirect_temporary`, `gsc_old_url_temporary`, `redirect_chain` |
| **No length limit for a title**: it is cut to the width of the screen. Google rewrites a title that is half empty, obsolete (an old year), inaccurate, or nearly identical from page to page. ([title links](https://developers.google.com/search/docs/appearance/title-link)) | Title lengths are low priority. `content_stale_year` (a past year), `ai_title_misfit` (an inaccurate title, judged by a model), `title_duplicate`, `title_repeated_segment` (the same segment twice, usually the site name) |
| **No length limit for a meta description**, and the snippet comes from the page content first. Bad examples given: the same description on every page, a list of keywords, a text that does not summarise the page. ([snippets](https://developers.google.com/search/docs/appearance/snippet)) | Lengths are low priority. `description_templated`, `description_duplicate` and `ai_description_misfit` carry the real check |
| **No preferred word count.** ([helpful content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)) | `content_low` (under 200 words) is low priority, "to review"; thin pages are judged by a model |
| To appear in AI Overviews and AI Mode: be indexed and **eligible for a snippet**. No special file or markup is needed. `nosnippet` and `max-snippet` limit what Google shows. ([AI features](https://developers.google.com/search/docs/appearance/ai-features)) | `directive_nosnippet`, high priority. The `llms.txt` and Markdown checks stay low priority and are labelled as a bet, not a best practice |
| "Every page you care about should have a link from at least one other page." Anchors like "click here", "read more", or empty ones are bad anchors; for an image, the anchor is its `alt`. ([links](https://developers.google.com/search/docs/crawling-indexing/links-crawlable)) | `sitemap_orphan`, `gsc_orphan`, `links_non_descriptive_anchor`, `links_empty_anchor`, `links_uncrawlable` |
| A sitemap holds **50 MB or 50,000 URLs** at most. Google uses `lastmod` only when it is verifiably accurate, and **ignores `priority` and `changefreq`**. ([sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)) | `sitemap_over_limit`, `sitemap_no_lastmod`, `sitemap_lastmod_identical` |
| Crawl budget only concerns sites with **more than a million pages**, or more than 10,000 pages that change every day. ([crawl budget](https://developers.google.com/search/docs/crawling-indexing/large-site-managing-crawl-budget)) | No crawl budget alert. Parameter URLs and depth stay low priority |
| Hyphens rather than underscores in URLs, and one case: `/APPLE` and `/apple` are two URLs. ([URL structure](https://developers.google.com/search/docs/crawling-indexing/url-structure)) | `url_underscores`, `url_uppercase` |
| The site name comes first from `WebSite` structured data (`name`, `url`) **on the home page**. ([site names](https://developers.google.com/search/docs/appearance/site-names)) | `site_name_schema` |
| A visible date, and `datePublished` or `dateModified` in the structured data of an article. ([dates](https://developers.google.com/search/docs/appearance/publication-dates)) | `schema_rich_result_warnings` |
| Ratings and reviews in structured data must be visible on the page, collected from users on the site, never aggregated from other sites, and never about the business itself. ([review snippet](https://developers.google.com/search/docs/appearance/structured-data/review-snippet)) | `schema_rating_not_shown`, `schema_self_serving_review` |
| Discover: an image **at least 1,200 px wide**, enabled by `max-image-preview:large`. ([Discover](https://developers.google.com/search/docs/appearance/google-discover)) | `discover_no_large_preview`, `og_image_small` |

## B. web.dev and Chrome

| Threshold | What the tool does with it |
| --- | --- |
| Core Web Vitals, at the 75th percentile of real visits: **LCP 2.5 s, INP 200 ms, CLS 0.1**. ([vitals](https://web.dev/articles/vitals)) | `perf_lcp`, `perf_cls`. The tool measures one load in a local Chrome, not real visitors: a gap is a lead, a pass proves nothing |
| TTFB: good up to **0.8 s**, poor above **1.8 s**. Not a Core Web Vital. ([TTFB](https://web.dev/articles/ttfb)) | `ttfb_needs_improvement`, `ttfb_poor` |
| Lighthouse warns above about **800 DOM nodes** and fails above about **1,400**. ([DOM size](https://developer.chrome.com/docs/lighthouse/performance/dom-size)) | `dom_over_1400` |
| **Never lazy-load the LCP image**, give it `fetchpriority="high"`, prefer AVIF or WebP. ([optimize LCP](https://web.dev/articles/optimize-lcp)) | `lcp_lazy`, `lcp_no_priority` (on the real LCP element, read while rendering), `image_legacy_format` |

## C. Measurement of the web

| Data | What the tool does with it |
| --- | --- |
| HTML document: median **33 kB**, 90th percentile **151 kB** on mobile. Whole page: median 2,164 kB, 72 requests. ([Web Almanac 2025, page weight](https://almanac.httparchive.org/en/2025/page-weight)) | `html_over_p90`: an HTML heavier than 90 % of the web |

## D. Independent research

| Result | What the tool does with it |
| --- | --- |
| **GEO: Generative Engine Optimization** (Aggarwal et al., KDD 2024, 10,000 queries): adding quotations, statistics and cited sources are the edits that raise visibility in generative answers the most, up to about 40 %; keyword stuffing lowers it. Sites ranked lower gain the most. ([arXiv 2311.09735](https://arxiv.org/abs/2311.09735)) | `geo_no_cited_source`, `geo_few_statistics`, on articles of 500 words or more. Tested on a 2023 engine: read it as a direction |
| **Pew Research** (900 US adults, March 2025): when an AI summary shows, 8 % of visits click a result, against 15 % without. A summary on 18 % of searches. ([Pew](https://www.pewresearch.org/short-reads/2025/07/22/google-users-are-less-likely-to-click-on-links-when-an-ai-summary-appears-in-the-results/)) | The clicks-to-gain estimate counts only half the usual click curve |

## E. Industry studies

| Result | What the tool does with it |
| --- | --- |
| **Backlinko** (4 million results, Search Console data, around 2022): 27.6 % of clicks at position 1, ten times position 10, and 32.3 % more clicks per position gained. ([Backlinko](https://backlinko.com/google-ctr-stats)) | The "usual" click curve: 27.6 % divided by 1.323 at each position (`CLICK_CURVE` in `lib/analyze.mjs`). `gsc_ctr_gap` flags a rate under a quarter of it; pages to push are sorted by clicks to gain at position 3. Only positions 1 and 10 are published in plain text; the rest is interpolated |
| **Zyppy** (23 million internal links, 1,800 sites): pages with 0 to 4 internal links get the fewest Google clicks; the more varied the anchors, the more traffic; past about 45 links, the effect reverses. Correlation. ([Zyppy](https://zyppy.com/seo/internal-links-study/)) | `links_few_inlinks` (fewer than 5 linking pages), `links_single_anchor` |
| **Vercel and MERJ** (December 2024): GPTBot, ClaudeBot and PerplexityBot **do not run JavaScript**; a third of their requests hit 404s, against 8 % for Googlebot. ([Vercel](https://vercel.com/blog/the-rise-of-the-ai-crawler)) | `js_content`: content that only exists after JavaScript is invisible to these crawlers. Redirects of old URLs matter twice |
| Several 2025 studies (Ahrefs, Seer Interactive) see the click rate of position 1 halve or more on queries with an AI Overview. Figures vary with the method. | No threshold: it is why a low click rate no longer means "bad title" on its own |

## F. Conventions, without evidence

| Threshold | Where it comes from |
| --- | --- |
| Title over 60 characters or 561 px, under 30; description over 155, under 70; H1 over 70; URL over 115 | Common SEO tool defaults. They estimate truncation on screen, not a Google rule. Low priority |
| Depth of 4 clicks or more | Common SEO tool default |
| Image over 100 kB | Common SEO tool default |
| Position 4 to 20 with 100 impressions or more | This project. Below position 3, each place gained counts (click curve); 100 impressions to avoid reasoning on noise |
| Link score under 40 | This project, to reread for each site |
| AI scores: 0.3 for an unfaithful title or description, 0.7 for a thin page, 0.75 for cannibalisation, 0.8 for a link to propose | This project, set by reading samples, not calibrated on a labelled set |
| Near duplicate: 5 simhash bits or fewer | This project |

## What the research says to stop treating as a fault

- **The length of a text.** Google has no preferred word count.
- **The exact length of a title or description.** No limit; what counts is that they describe the page and differ from page to page.
- **Crawl budget** on a site under a few tens of thousands of pages.
- **`llms.txt` for Google.** Google says it needs no file for AI. The file stays a bet on other agents.
- **`priority` and `changefreq`** in a sitemap: ignored.
- **A question in the title**: Backlinko finds no significant difference in clicks.

## Controls this research added

`redirect_temporary`, `gsc_old_url_temporary`, `directive_nosnippet`, `discover_no_large_preview`, `og_image_small`, `site_name_schema`, `content_stale_year`, `sitemap_no_lastmod`, `sitemap_lastmod_identical`, `html_over_p90`, `dom_over_1400`, `lcp_lazy`, `lcp_no_priority`, `image_legacy_format`, `links_few_inlinks`, `links_no_contextual_inlinks`, `links_single_anchor`, `geo_no_cited_source`, `geo_few_statistics`, `gsc_ctr_gap`, and the ranking of pages to push by clicks to gain.

DOM size, the LCP image and image formats usually come from PageSpeed Insights; here they come from the crawl and the local rendering.
