// The model client against a fake OpenRouter: Flex falls back to the normal tier after two refusals,
// and a billed answer that is not JSON is paid, counted, and asked once more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRouterClient, openRouterPricing } from '../lib/openrouter.mjs';

function fakeFetch(replies) {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const r = replies.shift();
    return new Response(JSON.stringify(r), { status: 200 });
  };
  return { fetch, sent };
}
const answer = (content, cost, tier = 'default') => ({ choices: [{ message: { content } }], usage: { cost }, service_tier: tier });

test('Flex is tried twice, then the normal tier', async () => {
  const busy = { error: { message: 'temporarily rate-limited upstream' } };
  const { fetch, sent } = fakeFetch([busy, busy, answer('{"a":1}', 0.0002)]);
  const client = openRouterClient({ apiKey: 'k', fetch, attempts: 1 });
  const r = await client.chat({ model: 'm', system: 's', user: 'u', schema: {}, tier: 'flex' });
  assert.deepEqual(sent.map((x) => x.body.service_tier ?? 'normal'), ['flex', 'flex', 'normal']);
  assert.equal(r.tier, 'normal');
  assert.equal(r.cost, 0.0002);
});

test('a Flex answer reports the flex tier and its cost', async () => {
  const { fetch } = fakeFetch([answer('{"a":1}', 0.0001, 'flex')]);
  const r = await openRouterClient({ apiKey: 'k', fetch }).chat({ model: 'm', system: 's', user: 'u', schema: {}, tier: 'flex' });
  assert.equal(r.tier, 'flex');
  assert.equal(r.cost, 0.0001);
});

test('an answer that is not JSON is billed, and asked once more', async () => {
  const { fetch, sent } = fakeFetch([answer('not json', 0.0001), answer('{"a":2}', 0.0001)]);
  const r = await openRouterClient({ apiKey: 'k', fetch }).chat({ model: 'm', system: 's', user: 'u', schema: {} });
  assert.equal(sent.length, 2);
  assert.deepEqual(r.value, { a: 2 });
  assert.equal(r.cost, 0.0002);
});

test('prices come from the public model list, including decision models', async () => {
  const { fetch, sent } = fakeFetch([{ data: [{ id: 'typesafe/jev-1.13', pricing: { prompt: '0.000000042', completion: '0' } }] }]);
  const p = openRouterPricing({ fetch });
  assert.deepEqual(await p.price('typesafe/jev-1.13'), { prompt: 4.2e-8, completion: 0 });
  assert.equal(await p.price('unknown/model'), null);
  assert.match(sent[0].url, /output_modalities=all/);
  assert.equal(sent.length, 1, 'the list is fetched once');
});
