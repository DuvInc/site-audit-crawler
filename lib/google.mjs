// The only file that talks to Google's Search Console API directly. Read-only scope.
// Two ways in, both without a dependency:
//   - an access token you already have (GSC_ACCESS_TOKEN), for example from
//     `gcloud auth application-default print-access-token` after a login with the webmasters scope;
//   - a service account key file (GOOGLE_APPLICATION_CREDENTIALS): a JWT signed here with node:crypto
//     and exchanged for a one-hour token. The service account's email must be added as a user of the
//     Search Console property.
import { createSign } from 'node:crypto';

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

/** A signed JWT assertion for the OAuth 2.0 JWT bearer flow (RFC 7523). */
export function signServiceAccountJwt(serviceAccount, { now = Math.floor(Date.now() / 1000), scope = GSC_SCOPE } = {}) {
  const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const header = b64({ alg: 'RS256', typ: 'JWT', ...(serviceAccount.private_key_id ? { kid: serviceAccount.private_key_id } : {}) });
  const claims = b64({
    iss: serviceAccount.client_email,
    scope,
    aud: serviceAccount.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(serviceAccount.private_key).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

async function exchange(serviceAccount, fetch) {
  const res = await fetch(serviceAccount.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signServiceAccountJwt(serviceAccount) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`Google token exchange failed (${res.status}): ${json.error_description ?? json.error ?? 'no token'}`);
  return json.access_token;
}

// Paths are the ones of the API reference, relative: webmasters/v3/... or v1/urlInspection/...
const urlFor = (path) => (path.startsWith('v1/') ? `https://searchconsole.googleapis.com/${path}` : `https://www.googleapis.com/${path}`);

/**
 * A Search Console transport: `(path, body?) => Promise<json>`. GET without a body, POST with one.
 * @param {object} o
 * @param {string} [o.accessToken]
 * @param {object} [o.serviceAccount] the parsed key file
 * @param {Function} [o.fetch]
 */
export function googleTransport({ accessToken, serviceAccount, fetch = globalThis.fetch }) {
  if (!accessToken && !serviceAccount) throw new Error('googleTransport needs an access token or a service account key.');
  let token = accessToken ? Promise.resolve(accessToken) : null;
  return async (path, body) => {
    token ??= exchange(serviceAccount, fetch);
    const res = await fetch(urlFor(path), {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${await token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Search Console ${res.status}: ${json.error?.message ?? 'no detail'}`);
    return json;
  };
}
