// The structured data plan, per template: what the template is (its role), which types it should
// carry (the catalogue, structured-data.mjs), and for each field its state on the sample pages:
// present and valid, present but wrong, missing though the page shows the value (and where), missing.
// Rules only, no model: a template the rules cannot place is "open", for a decision model to settle.
// The customer's coding agent reads the plan and changes the template once, not every page.
// No Node import: runs on any database handle.
import { TYPES_BY_ROLE, CATALOGUE_VERSION, entryFor, fieldsFor, validateNode } from './structured-data.mjs';
import { templatesOf } from './templates.mjs';

/** Of the template's pages, the share that must show a field at one element for it to be the template's. */
const CONSISTENT = 0.6;

const first = (shape) => shape.split('/')[1] ?? '';
const SHAPES = {
  legal: /^(legal|legal-notice|privacy|privacy-policy|terms|terms-and-conditions|terms-of-service|tos|cookies?|cookie-policy|cookie-information|impressum|imprint|mentions-legales|datenschutz|agb|cgu|cgv|dpa|data-processing-agreement|gdpr|disclaimer|conditions)$/,
  contact: /^(contact|contact-us|kontakt|contacto|contatti|contato)$/,
  about: /^(about|about-us|a-propos|uber-uns|ueber-uns|chi-siamo|quienes-somos|sobre|sobre-nos|team|company|our-story)$/,
  article: /^(blog|news|articles?|posts?|magazine|journal|guides?|stories|insights|actualites|ratgeber)$/,
  tool: /^(tools?|outils|werkzeuge|herramientas|strumenti|ferramentas|calculators?|generators?)$/,
  event: /^(events?|agenda|veranstaltungen|eventos|eventi|evenements|webinars?)$/,
  product: /^(shop|store|boutique|products?|produkte|produits|productos|prodotti|produtos|p|item|items|catalog|catalogue|collections)$/,
  pricing: /^(pricing|prices|plans|tarifs|prix|preise|precios|prezzi|precos|prijzen|abonnements?)$/,
  docs: /^(docs|documentation|doc|help|help-center|helpcenter|support|kb|knowledge-base|api|api-reference|reference|manual|hilfe|aide|ayuda|aiuto)$/,
  profile: /^(authors?|team|people|contributors|writers|autoren|auteurs?|autores|autori)$/,
  job: /^(careers?|jobs?|stellen|stellenangebote|emplois?|carrieres?|empleos?|lavora-con-noi|vacatures)$/,
  comparison: /^(vs|versus|compare|comparison|comparisons|alternatives?|alternativen|vergleich|comparatif|comparativa)$/,
  video: /^(videos?|watch|tv)$/,
};
const hasType = (t, ...names) => Object.keys(t.schema_types).some((k) => names.includes(k));
const consistent = (t, field) => (t.paths[field]?.pages ?? 0) >= Math.max(1, t.pages * CONSISTENT);

/**
 * The role of a template, with the reason, from its address, the fields it shows at one place on most
 * of its pages, and the types it already declares. `decided: "open"` when nothing settles it.
 */
export function roleOf(t, allShapes = []) {
  const seg = first(t.shape);
  const single = !t.shape.includes('*');
  const rule = (role, why) => ({ role, why, decided: 'rules' });
  if (t.shape === '/') return rule('home', 'the root of the site');
  if (single && SHAPES.legal.test(seg)) return rule('legal', `the address /${seg}`);
  if (single && SHAPES.contact.test(seg)) return rule('contact', `the address /${seg}`);
  if (single && SHAPES.about.test(seg)) return rule('about', `the address /${seg}`);
  if (single && SHAPES.pricing.test(seg)) return rule('pricing', `the address /${seg}`);
  if (!single && SHAPES.profile.test(seg)) return rule('profile', `pages under /${seg}/`);
  if (!single && SHAPES.job.test(seg)) return rule('job', `pages under /${seg}/`);
  if (!single && SHAPES.comparison.test(seg)) return rule('comparison', `pages under /${seg}/`);
  if (!single && SHAPES.docs.test(seg)) return rule('docs', `pages under /${seg}/`);
  if (!single && (SHAPES.video.test(seg) || hasType(t, 'VideoObject'))) return rule('video', hasType(t, 'VideoObject') ? 'it already declares VideoObject' : `pages under /${seg}/`);
  // Before the declared types: a blog index that declares BlogPosting is still a list of posts.
  if (single && allShapes.some((s) => s.startsWith(`/${seg}/`))) return rule('listing', `the index of the pages under /${seg}/`);
  if (hasType(t, 'Event') || (!single && SHAPES.event.test(seg))) return rule('event', hasType(t, 'Event') ? 'it already declares Event' : `pages under /${seg}/`);
  if (hasType(t, 'WebApplication', 'SoftwareApplication') || (!single && SHAPES.tool.test(seg))) return rule('tool', hasType(t, 'WebApplication', 'SoftwareApplication') ? 'it already declares an application' : `pages under /${seg}/`);
  // A price alone is not a product: pricing tables sit on comparison and plan pages too. A product page
  // is a page of a shop section that shows its price at one place, or one that says so itself.
  if (hasType(t, 'Product')) return rule('product', 'it already declares Product');
  if (t.product_meta) return rule('product', 'its pages carry product:price meta tags');
  if (!single && SHAPES.product.test(seg) && consistent(t, 'prices')) return rule('product', `a price at ${t.paths.prices.path} on ${t.paths.prices.pages} of ${t.pages} pages under /${seg}/`);
  if (consistent(t, 'addresses') && consistent(t, 'phones')) return rule('location', `an address and a phone on ${t.paths.addresses.pages} of ${t.pages} pages`);
  if (hasType(t, 'Article', 'BlogPosting', 'NewsArticle')) return rule('article', 'it already declares an article');
  if (!single && SHAPES.article.test(seg)) return rule('article', `pages under /${seg}/`);
  if (!single && consistent(t, 'times') && (t.fields.authors || SHAPES.article.test(seg))) return rule('article', `a date at ${t.paths.times.path} on ${t.paths.times.pages} of ${t.pages} pages`);
  return { role: 'other', why: 'no rule fits', decided: 'open' };
}

const parse = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};
const getDeep = (node, key) => key.split('.').reduce((v, k) => (v === undefined || v === null ? undefined : Array.isArray(v) ? v[0]?.[k] : v[k]), node);
const blank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

/** Every node of a page's JSON-LD with a @type, @graph and nesting walked. */
function nodesOf(json) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n['@type']) out.push(n);
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
  };
  walk(json);
  return out;
}

/** Whether a type is satisfied by a node: the type itself or one of its subtypes (Restaurant is a LocalBusiness). */
const APP_TYPES = ['SoftwareApplication', 'WebApplication', 'MobileApplication'];
const nodeFor = (nodes, type) =>
  nodes.find((n) => [].concat(n['@type']).some((t) => t === type || entryFor(t)?.base === type || (APP_TYPES.includes(type) && APP_TYPES.includes(t))));

/**
 * Where a page shows the value of a field, from the stored evidence, or null. Only what the crawl can
 * see: a value it cannot find is the owner's to give, never guessed.
 */
function shownAt(key, page, ev, t, type) {
  const at = (field) => (ev?.[field] ? (t.paths[field]?.path ?? [].concat(ev[field])[0]?.path ?? 'the page') : null);
  // A business or a person is named by the site's name, not by the H1 (on a home page, a tagline).
  const identity = type === 'Person' || ['Organization', 'LocalBusiness', 'WebSite'].includes(entryFor(type)?.base);
  // The product is usually named like the site; the employer of a job is the site's company.
  const named = identity || ['SoftwareApplication', 'WebApplication'].includes(type) && t.role === 'pricing';
  if ((key === 'name' && named) || key === 'hiringOrganization.name') return ev?.meta?.['og:site_name'] ? 'meta[property=og:site_name]' : null;
  if (key === 'title' || key === 'mainEntity.name') return page.h1 ? 'h1' : null;
  if (key === 'mainEntity.description') return page.description ? 'meta[name=description]' : null;
  if (key === 'datePosted') return at('times');
  if (key.startsWith('jobLocation.address.')) return at('addresses');
  if (key === 'headline' || key === 'name') return page.h1 ? 'h1' : page.title ? 'title' : null;
  if (key === 'description') return page.description ? 'meta[name=description]' : null;
  if (key === 'image') return parse(page.og)?.['og:image'] ? 'meta[property=og:image]' : null;
  if (key === 'url') return 'the page address';
  if (/^(datePublished|startDate)$/.test(key)) return ev?.meta?.['article:published_time'] ? 'meta[property=article:published_time]' : at('times');
  if (key === 'dateModified') return ev?.meta?.['article:modified_time'] ? 'meta[property=article:modified_time]' : null;
  if (key === 'author.name') return ev?.meta?.author ? 'meta[name=author]' : at('authors');
  if (key === 'offers.price') return ev?.meta?.['product:price:amount'] ? 'meta[property=product:price:amount]' : at('prices');
  if (key === 'offers.priceCurrency') return ev?.meta?.['product:price:currency'] ? 'meta[property=product:price:currency]' : at('prices');
  if (key.startsWith('address.')) return at('addresses');
  if (key === 'telephone') return at('phones');
  if (key === 'email') return at('emails');
  if (key === 'itemListElement') return at('breadcrumb');
  return null;
}

/** One field across the samples: the state most samples are in, and where the value is shown. */
function fieldState(field, type, samples, t) {
  const states = samples.map((s) => {
    const node = nodeFor(s.nodes, type);
    const value = node ? getDeep(node, field.key) : undefined;
    if (node && !blank(value)) {
      const wrong = validateNode(node).find((i) => i.path === field.key && (i.code === 'format' || i.code === 'required_missing'));
      return wrong ? { state: 'wrong', why: wrong.detail ?? wrong.code } : { state: 'valid' };
    }
    const where = shownAt(field.key, s.page, s.ev, t, type);
    return where ? { state: 'on_page', where } : { state: 'missing' };
  });
  const order = ['valid', 'wrong', 'on_page', 'missing'];
  const count = (st) => states.filter((x) => x.state === st).length;
  const state = order.reduce((best, st) => (count(st) > count(best) ? st : best), order[0]);
  const pick = states.find((x) => x.state === state) ?? {};
  return { key: field.key, level: field.level, state, ...(pick.where ? { where: pick.where } : {}), ...(pick.why ? { why: pick.why } : {}), hint: field.hint };
}

/** The identity type the site already uses (Organization, LocalBusiness and their subtypes, Person), or Organization. */
function identityOf(templates) {
  const counts = {};
  for (const t of templates) for (const [k, n] of Object.entries(t.schema_types)) if (k === 'Person' || ['Organization', 'LocalBusiness'].includes(entryFor(k)?.base)) counts[k] = (counts[k] ?? 0) + n;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Organization';
}

/**
 * The plan for a crawl: every template with its role, the types it should carry and each field's state
 * on its sample pages, the most to gain first (todo times pages). `roles` ({ shape: role }) settles the
 * templates the rules leave open, from a decision model; a template the rules place keeps its role.
 */
export function schemaPlan(db, { samples = 3, max = 60, roles = {} } = {}) {
  const templates = templatesOf(db, { samples, max: 400 });
  const shapes = templates.map((t) => t.shape);
  const identity = identityOf(templates);
  const read = db.prepare('SELECT url, title, h1, description, og, schema_json, field_evidence FROM pages WHERE url = ?');
  const home = templates.find((t) => t.shape === '/');
  // A product that only runs in a browser is a WebApplication; links to an app store or a download
  // say there is software to install, so SoftwareApplication (Google reads both).
  const installs = db.prepare("SELECT 1 FROM links WHERE dst LIKE '%apps.apple.com/%' OR dst LIKE '%play.google.com/store/%' OR dst LIKE '%microsoft.com/store/%' OR dst LIKE '%.dmg' OR dst LIKE '%.exe' OR dst LIKE '%.msi' OR dst LIKE '%.AppImage' LIMIT 1").get();
  const productType = installs ? 'SoftwareApplication' : 'WebApplication';
  const homeHasIdentity = Boolean(home?.samples.some((u) => nodeFor(nodesOf(parse(read.get(u)?.schema_json)), identity)));
  const plans = templates.map((tpl) => {
    let t = tpl;
    const pages = t.samples.map((u) => read.get(u)).filter(Boolean).map((page) => ({ page, ev: parse(page.field_evidence), nodes: nodesOf(parse(page.schema_json)) }));
    const ruled = roleOf({ ...t, product_meta: pages.length > 0 && pages.every((p) => p.ev?.meta?.['product:price:amount']) }, shapes);
    // A template the rules leave open takes the role a decision model chose from its sample page, if given.
    const role = ruled.decided === 'open' && TYPES_BY_ROLE[roles[t.shape]] ? { role: roles[t.shape], why: 'chosen by a model from its sample page', decided: 'model' } : ruled;
    t = { ...t, role: role.role };
    // A trail earns its place below the first level: Home > Privacy says nothing a reader needs.
    const deep = t.shape.split('/').filter(Boolean).length > 1;
    // The identity lives once, on the home page; an about or contact page points at it by @id.
    const identityElsewhere = ['about', 'contact'].includes(role.role) && homeHasIdentity;
    const types = (TYPES_BY_ROLE[role.role] ?? ['BreadcrumbList'])
      .map((x) => (x === 'identity' ? identity : x === 'SoftwareApplication' ? productType : x))
      .filter((x) => (x !== 'BreadcrumbList' || deep) && !(x === identity && identityElsewhere));
    const planned = types.map((type) => {
      // The product on a pricing page is described as a product (its plans, its category), whichever app type it is.
      const fields = fieldsFor(role.role === 'pricing' && APP_TYPES.includes(type) ? 'SoftwareApplication' : type)
        .filter((f) => !(type === 'WebSite' && f.key === 'potentialAction'))
        .map((f) => fieldState(f, type, pages, t));
      const present = pages.filter((p) => nodeFor(p.nodes, type)).length;
      return { type, on_samples: `${present} of ${pages.length}`, fields };
    });
    const declared = Object.keys(t.schema_types).filter((k) => !planned.some((p) => p.type === k || entryFor(k)?.base === p.type));
    // todo: what the template can fix from its own pages (a required field, or a recommended one that
    // is wrong or shown on the page). to_supply: recommended values the crawl could not find, the
    // owner's to give (a VAT number, an address), never guessed.
    const todo = planned.reduce((n, p) => n + p.fields.filter((f) => f.state !== 'valid' && (f.level === 'required' || (f.level === 'recommended' && f.state !== 'missing'))).length, 0);
    const to_supply = planned.reduce((n, p) => n + p.fields.filter((f) => f.level === 'recommended' && f.state === 'missing').length, 0);
    return {
      shape: t.shape,
      pages: t.pages,
      langs: t.langs,
      role: role.role,
      role_why: role.why,
      decided: role.decided,
      samples: t.samples,
      types: planned,
      // Declared on the template beyond the plan: kept unless a rule says otherwise (WebSite off the home page).
      also_declared: declared,
      ...(role.role !== 'home' && declared.includes('WebSite') ? { remove: ['WebSite: Google reads it on the home page only'] } : {}),
      ...(identityElsewhere ? { identity: `on the home page: reference it by its @id` } : {}),
      todo,
      to_supply,
      pages_cut: t.pages_cut,
    };
  });
  return {
    catalogue_version: CATALOGUE_VERSION,
    identity_type: identity,
    product_type: productType,
    templates: plans.sort((a, b) => b.todo * b.pages - a.todo * a.pages || b.pages - a.pages).slice(0, max),
  };
}
