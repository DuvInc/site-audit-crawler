// robots.txt, read the way RFC 9309 describes it: groups of user-agents, the most specific
// group wins over `*`, and inside a group the longest matching rule wins (Allow on a tie).

export function parseRobots(txt) {
  const groups = [];
  const sitemaps = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === 'user-agent') {
      // Consecutive User-agent lines share one group.
      if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (k === 'sitemap') sitemaps.push(v);
    else if (cur && (k === 'allow' || k === 'disallow') && v) cur.rules.push({ allow: k === 'allow', path: v });
  }
  return { groups, sitemaps };
}

/** Is `path` (pathname plus query) allowed for `agent`, a full user-agent string or a bot token? */
export function robotsAllows(robots, path, agent) {
  const ua = agent.toLowerCase();
  // A crawler that matches its own group ignores the rules of `*`.
  const g = robots.groups.find((x) => x.agents.some((a) => a !== '*' && ua.includes(a))) ?? robots.groups.find((x) => x.agents.includes('*'));
  if (!g) return true;
  let best = null;
  for (const r of g.rules) {
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}
