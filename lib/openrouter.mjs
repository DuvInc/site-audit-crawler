// The only file that talks to OpenRouter (https://openrouter.ai). Two calls:
//   decide()  a decision model (default typesafe/jev-1.13) on OpenRouter's alpha Decisions API: it
//             writes nothing, it returns a probability per typed question (noul, choice, score).
//             Input is billed, output is free. The API is in alpha and may change.
//   chat()    a chat model with a JSON schema as response_format, for the two steps that must write
//             (the taxonomy and the target query of each page).
// Both read the cost OpenRouter reports for the call, so the budget is measured, not estimated.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const callCost = (usage) => (usage?.cost ?? 0) + (usage?.is_byok ? (usage?.cost_details?.upstream_inference_cost ?? 0) : 0);

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} [o.baseUrl]  e.g. a Cloudflare AI Gateway URL in front of OpenRouter
 * @param {Function} [o.fetch]
 * @param {number} [o.attempts]
 */
export function openRouterClient({ apiKey, baseUrl = 'https://openrouter.ai/api', fetch = globalThis.fetch, attempts = 4 }) {
  if (!apiKey) throw new Error('No OpenRouter key: set OPENROUTER_API_KEY (https://openrouter.ai/keys).');
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-title': 'site-audit-crawler' };

  // Retries what is not the caller's fault: network errors, 429, 5xx, an error inside an HTTP 200.
  async function post(path, body, read) {
    let last = 'unknown';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(120000) });
        // Read as text first: a gateway under load can answer with an HTML page.
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        if (res.ok && json && !json.error) {
          const out = read(json);
          if (out) return out;
          last = 'empty answer';
        } else {
          last = `HTTP ${res.status} ${JSON.stringify(json?.error ?? text.slice(0, 200))}`;
          if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
        }
      } catch (e) {
        last = e.message;
      }
      if (attempt < attempts) await sleep(800 * attempt);
    }
    throw new Error(last);
  }

  return {
    /** `body` is passed as a string so the caller can hash exactly what is sent. */
    decide: (body) => post('/alpha/decisions', body, (json) => json.answers && { answers: json.answers, cost: callCost(json.usage) }),

    chat: ({ model, system, user, schema, maxTokens = 1500, reasoning = 'none' }) =>
      post('/v1/chat/completions', JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        // 'none' is the cheapest level on the default model; a model that requires reasoning refuses it.
        reasoning: reasoning ? { effort: reasoning } : undefined,
        max_tokens: maxTokens,
        usage: { include: true },
        // The schema constrains the decoder; require_parameters stops a provider from ignoring it.
        response_format: { type: 'json_schema', json_schema: { name: 'output', strict: false, schema } },
        provider: { require_parameters: true },
      }), (json) => {
        const content = json.choices?.[0]?.message?.content;
        if (!content) return null;
        return { value: JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '')), cost: callCost(json.usage), reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens ?? 0 };
      }),
  };
}
