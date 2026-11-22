// report.md: the human-readable view of summary.json. Every number in it comes from a query on
// crawl.db, so a reader who doubts a line can run the query.
import { hasTable, readMeta } from './schema.mjs';

export function renderReport(db, summary) {
  const meta = readMeta(db);
  const START = summary.site;
  const origin = new URL(START).origin;
  const hasGsc = Boolean(summary.gsc);
  const hasAi = Boolean(summary.ai);
  const hasOpps = hasTable(db, 'ai_link_opps');
  const air = summary.ai_readiness;
  const md = [];
  const table = (head, rows) => {
    if (!rows.length) return;
    md.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
    for (const r of rows) md.push(`| ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`);
    md.push('');
  };
  const short = (u) => (u.startsWith(origin) ? u.slice(origin.length) || '/' : u);
  const h = summary.html_pages;

  md.push(`# Site audit: ${meta.host}`, '', `Crawled on ${meta.started_at.slice(0, 10)}: ${summary.urls.total} URLs in ${meta.seconds} s (${summary.urls.internal} internal, ${summary.urls.external} external). Every line below comes from a query on \`crawl.db\`; thresholds and their sources are in \`docs/thresholds.md\` of site-audit-crawler.`, '');

  md.push('## Overview', '');
  table(['Internal HTML pages', 'Indexable', 'Words (median)', 'TTFB (median)', 'HTML (median)'], [[h.total, summary.indexable_pages, h.words_median, `${h.ttfb_ms_median} ms`, `${h.html_kb_median} kB`]]);
  table(['Indexability', 'Pages'], h.indexability.map((r) => [r.indexability, r.n]));
  table(['Depth (clicks from the start URL)', 'Pages'], h.by_depth.map((r) => [r.depth ?? 'not linked', r.n]));
  table(['Status code', 'Internal', 'External'], [...new Set(summary.urls.by_status.map((r) => r.status))].sort((a, b) => a - b).map((s) => [s ?? 'blocked', summary.urls.by_status.find((r) => r.status === s && r.internal)?.n ?? 0, summary.urls.by_status.find((r) => r.status === s && !r.internal)?.n ?? 0]));

  md.push('## Findings', '', `${summary.issues.length} controls with findings, out of ${summary.rules_run} run.`, '');
  table(['Priority', 'Category', 'Control', 'URLs', 'Examples'], summary.issues.map((i) => [i.priority, i.category, i.label, i.urls, i.examples.slice(0, 2).map((e) => short(e.url) + (e.detail ? ` (${String(e.detail).replaceAll(origin, '').slice(0, 110)})` : '')).join('<br>')]));

  md.push('## Sections', '');
  table(['Section', 'Indexable pages', 'Words (avg)', 'Link score (avg)', 'Linking pages (avg)', 'Medium and high findings', ...(hasGsc ? ['Pages shown in Google', 'Impressions', 'Clicks'] : [])], summary.sections.map((g) => [g.section, g.pages, g.words_avg, g.link_score_avg, g.inlinks_avg, g.issues_medium_high, ...(hasGsc ? [g.pages_shown_in_google, g.impressions, g.clicks] : [])]));

  if (hasGsc) {
    const g = summary.gsc;
    md.push('## Google Search Console', '', `Property \`${g.property}\`, ${g.startDate} to ${g.endDate}, read through ${g.source === 'treg' ? 'treg' : 'the Search Console API'}. Total without dimension: **${g.total.clicks} clicks, ${g.total.impressions} impressions**, average position ${g.total.position?.toFixed(1)}. The sum by page (${g.by_page_sum.impressions} impressions) is higher: a search that shows two of your pages counts twice there. Queries by page are incomplete, Google hides rare queries.`, '', `${g.indexable_pages_shown} of ${g.indexable_pages} indexable pages had at least one impression.`, '');
    table(['Page', 'Impressions', 'Clicks', 'CTR', 'Position', 'Link score', 'Most shown query', ...(hasAi ? ['Target query (AI)'] : [])], g.top_pages.map((r) => [short(r.url), r.impressions, r.clicks, `${r.ctr_pct} %`, r.position, r.link_score ?? '', r.top_query ?? '', ...(hasAi ? [r.target_query ?? ''] : [])]));
    if (g.potential.length) {
      md.push('Pages to push, sorted by clicks to gain. The gain is an order of magnitude to sort by, not a forecast: impressions times half the usual click rate at position 3 (Backlinko curve, halved for AI summaries after Pew), minus current clicks.', '');
      table(['Page', 'Position', 'Impressions', 'Clicks', 'Clicks to gain at position 3', 'Link score', 'Linking pages', ...(hasOpps ? ['Links proposed'] : [])], g.potential.slice(0, 20).map((r) => [short(r.url), r.position, r.impressions, r.clicks, r.clicks_to_gain_at_position_3, r.link_score, r.linking_pages, ...(hasOpps ? [r.links_proposed] : [])]));
    }
    table(['Query', 'Impressions', 'Clicks', 'Position'], g.top_queries.map((r) => [r.query, r.impressions, r.clicks, r.position]));
    if (g.by_page_type) table(['Page type (AI)', 'Pages', 'Shown in Google', 'Impressions', 'Clicks'], g.by_page_type.map((r) => [r.page_type, r.pages, r.shown, r.impressions, r.clicks]));
    if (g.by_topic) table(['Topic (AI)', 'Pages', 'Shown in Google', 'Impressions', 'Clicks'], g.by_topic.map((r) => [r.topic, r.pages, r.shown, r.impressions, r.clicks]));
    if (g.inspection.length) {
      md.push('URL inspection of indexable pages with no impression (best linked first):', '');
      table(['Status at Google', 'Pages'], g.inspection.map((r) => [r.coverage, r.pages]));
    }
  }

  if (air) {
    md.push('## Readability for AI crawlers and agents', '');
    const bots = Object.entries(air.bots);
    table(['Check', 'Result'], [
      ['/llms.txt', `${air.llms_txt.status} ${air.llms_txt.content_type ?? ''}`],
      ['/llms-full.txt', `${air.llms_full_txt.status} ${air.llms_full_txt.content_type ?? ''}`],
      ['Home page with a GPTBot user-agent', air.home_as_gptbot.status],
      ['Home page with Accept: text/markdown', air.home_as_markdown.content_type],
      ['AI crawlers named in robots.txt', `${bots.filter(([, b]) => b.named).length} of ${bots.length}`],
      ['AI crawlers disallowed', bots.filter(([, b]) => !b.allowed).map(([n]) => n).join(', ') || 'none'],
      ['Pages that declare a Markdown version', `${summary.markdown_versions.pages} of ${summary.markdown_versions.of}`],
    ]);
  }

  if (hasAi) {
    md.push('## AI reading (a chat model for the taxonomy and target queries, a decision model for the judgments)', '');
    table(['Page type', 'Pages', 'Words (avg)', 'Link score', 'Faithful title', 'Faithful description', 'Gets to the point', 'Thin page'], summary.ai.page_types.map((r) => [r.page_type, r.pages, r.words_avg, r.link_score_avg, r.title_fit, r.description_fit, r.answer_first, r.thin]));
    const types = summary.ai.page_types.filter((r) => r.pages >= 5).map((r) => r.page_type);
    table(['Topic', 'Pages', ...types], summary.ai.topics.map((t) => [t.topic, t.pages, ...types.map((ty) => summary.ai.topic_by_type.find((x) => x.topic === t.topic && x.page_type === ty)?.pages ?? '')]));
    if (summary.ai.cannibalisation.length) {
      md.push('Pairs of pages that target the same search (0.75 and above: to fix; below: to review):', '');
      table(['AI score', 'Page', 'Page', ...(hasGsc ? ['Google queries in common'] : [])], summary.ai.cannibalisation.map((r) => [r.p, short(r.a), short(r.b), ...(hasGsc ? [r.shared_google_queries] : [])]));
    }
    if (summary.ai.link_opportunities.length) {
      md.push('Internal links to add (the source page names the subject of the target without linking to it):', '');
      table(['AI score', 'Source page', 'Anchor already in the text', 'Target'], summary.ai.link_opportunities.map((r) => [r.p, short(r.source), r.phrase, short(r.target)]));
    }
  }

  md.push('## Internal linking', '', 'Pages best served by internal links:', '');
  table(['Page', 'Link score', 'Linking pages', 'Depth'], summary.top_link_score.map((r) => [short(r.url), r.link_score, r.unique_inlinks, r.depth]));
  md.push('Indexable pages least served:', '');
  table(['Page', 'Link score', 'Linking pages', 'Depth'], summary.weakest_linked.map((r) => [short(r.url), r.link_score, r.unique_inlinks, r.depth ?? 'not linked']));

  md.push('## Weight and speed', '');
  table(['Heaviest HTML', 'kB', 'Words', 'DOM nodes'], summary.heaviest_html.map((r) => [short(r.url), r.kb, r.word_count, r.dom_nodes]));
  table(['Slowest responses', 'TTFB'], summary.slowest.map((r) => [short(r.url), `${r.ttfb_ms} ms`]));

  if (summary.schema_types.length) {
    md.push('## Structured data', '');
    table(['Type', 'Pages'], summary.schema_types.map((r) => [r.type, r.pages]));
  }

  if (summary.rendered) {
    md.push('## JavaScript rendering (one page per template, local Chrome)', '');
    table(['Page', 'Words after rendering', 'Links added by JS', 'Requests', 'Transferred', 'LCP', 'CLS', 'JS errors', 'axe rules failed'], summary.rendered.map((r) => [short(r.url), r.word_count, r.new_links, r.requests, `${r.transfer_kb} kB`, `${r.lcp_ms} ms`, r.cls, r.js_errors, r.axe_rules_failed]));
  }
  return md.join('\n');
}
