// The structured data catalogue: the builder writes what Google reads, and the validator says
// required apart from recommended, catches self-written reviews and properties of the wrong type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TYPES, buildJsonLd, entryFor, fieldsFor, labelFor, validateJsonLd, validateNode } from '../lib/structured-data.mjs';

const codes = (node) => validateNode(node).map((i) => `${i.code}:${i.path}`);

test('a bakery with name and address has no error, and is told what it misses', () => {
  const node = buildJsonLd('Bakery', {
    name: 'Bäckerei Müller', 'address.streetAddress': 'Kastanienallee 1', 'address.postalCode': '10435',
    'address.addressLocality': 'Berlin', 'address.addressCountry': 'DE', telephone: '+49 30 1234567',
    openingHoursSpecification: [{ days: ['Monday', 'Tuesday'], opens: '07:00', closes: '18:00' }],
  });
  assert.equal(node['@type'], 'Bakery');
  assert.equal(node.address['@type'], 'PostalAddress');
  assert.deepEqual(node.openingHoursSpecification[0].dayOfWeek, ['Monday', 'Tuesday']);
  const issues = validateNode(node);
  assert.ok(!issues.some((i) => i.level === 'error'), JSON.stringify(issues));
  assert.ok(codes(node).includes('recommended_missing:geo.latitude'));
});

test('a local business without its address cannot get a result', () => {
  assert.ok(codes({ '@type': 'Plumber', name: 'Rohr Schmidt' }).includes('required_missing:address.streetAddress'));
});

test('reviews on the business itself are an error', () => {
  const issues = validateNode({ '@type': 'Florist', name: 'X', aggregateRating: { ratingValue: 5 } });
  assert.ok(issues.some((i) => i.code === 'self_serving_review' && i.level === 'error'));
});

test('a company does not get opening hours or a map', () => {
  assert.equal(fieldsFor('Corporation').some((x) => x.key === 'openingHoursSpecification'), false);
  const node = buildJsonLd('Corporation', { name: 'Acme', openingHoursSpecification: [{ days: ['Monday'], opens: '09:00', closes: '17:00' }] });
  assert.equal(node.openingHoursSpecification, undefined);
  assert.ok(codes({ '@type': 'Corporation', name: 'Acme', hasMap: 'https://maps.example' }).includes('not_for_type:hasMap'));
});

test('cuisine is offered to a restaurant, not to a plumber', () => {
  assert.ok(fieldsFor('Restaurant').some((x) => x.key === 'servesCuisine'));
  assert.ok(!fieldsFor('Plumber').some((x) => x.key === 'servesCuisine'));
});

test('formats Google rejects are warnings', () => {
  const c = codes({ '@type': 'Bakery', name: 'X', telephone: '030 1234', 'address': { streetAddress: 'a', postalCode: '1', addressLocality: 'b', addressCountry: 'Germany' }, geo: { latitude: 52.5, longitude: 13.4 } });
  assert.ok(c.includes('format:telephone'));
  assert.ok(c.includes('format:address.addressCountry'));
  assert.ok(c.includes('format:geo.latitude'));
});

test('a product needs a price; an event needs a venue', () => {
  assert.ok(codes({ '@type': 'Product', name: 'Mug' }).includes('required_missing:offers.price'));
  const event = buildJsonLd('Event', { name: 'Concert', startDate: '2026-12-05T19:00+01:00', 'location.name': 'Hall', 'location.address.streetAddress': 'Main 1', 'location.address.postalCode': '1', 'location.address.addressLocality': 'Berlin', 'location.address.addressCountry': 'DE', 'offers.price': '0', eventStatus: 'EventScheduled' });
  assert.equal(event.location['@type'], 'Place');
  assert.equal(event.location.address['@type'], 'PostalAddress');
  assert.equal(event.offers.price, 0);
  assert.equal(event.eventStatus, 'https://schema.org/EventScheduled');
  assert.ok(!validateNode(event).some((i) => i.level === 'error'));
});

test('a breadcrumb: positions are numbered, the last step has no address', () => {
  const node = buildJsonLd('BreadcrumbList', { itemListElement: [{ name: 'Home', item: 'https://a.example/' }, { name: 'Blog', item: 'https://a.example/blog' }, { name: 'Post', item: 'https://a.example/blog/x' }] });
  assert.deepEqual(node.itemListElement.map((i) => i.position), [1, 2, 3]);
  assert.equal(node.itemListElement[2].item, undefined);
  assert.deepEqual(validateNode(node), []);
  assert.ok(codes({ '@type': 'BreadcrumbList', itemListElement: [{ position: 1, name: 'Home' }, { position: 2, name: 'x' }] }).includes('required_missing:itemListElement[0].item'));
});

test('FAQ is valid but retired in Google; a free tool earns no result without real ratings', () => {
  const faq = buildJsonLd('FAQPage', { mainEntity: [{ name: 'Open on Sunday?', 'acceptedAnswer.text': 'No.' }] });
  assert.equal(faq.mainEntity[0]['@type'], 'Question');
  assert.equal(faq.mainEntity[0].acceptedAnswer['@type'], 'Answer');
  assert.deepEqual(validateNode(faq).map((i) => i.code), ['retired_in_google']);
  const tool = buildJsonLd('WebApplication', { name: 'Checker', 'offers.price': '0', isAccessibleForFree: true });
  assert.ok(validateNode(tool).some((i) => i.code === 'no_rating_no_result' && i.level === 'info'));
});

test('a graph is judged node by node, nested nodes through their parent', () => {
  const found = validateJsonLd({ '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebSite', name: 'A', url: 'https://a.example/' },
    { '@type': 'BlogPosting', headline: 'H', author: { '@type': 'Person', name: 'W' } },
  ] });
  assert.deepEqual(found.map((n) => n.types[0]), ['WebSite', 'BlogPosting']);
  assert.ok(!found[1].issues.some((i) => i.path === 'jobTitle'));
});

test('every subtype resolves, and every field has a hint and a level', () => {
  for (const [base, entry] of Object.entries(TYPES)) {
    for (const t of entry.subtypes ?? [base]) assert.equal(entryFor(t).base, base);
    for (const x of entry.fields) {
      assert.ok(['required', 'recommended', 'optional'].includes(x.level), `${base}.${x.key}`);
      assert.ok(x.hint.length > 5 && !/—/.test(x.hint), `${base}.${x.key}`);
    }
  }
});
