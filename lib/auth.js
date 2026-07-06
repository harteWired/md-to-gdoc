// OAuth access-token minting. Reads credentials via config.js and caches a
// short-lived access token so back-to-back commands don't re-hit Google.
// Stateless: no server, nothing runs when idle.

import { resolveCreds, readTokenCache, writeTokenCache } from './config.js';

export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

async function refresh() {
  const { clientId, clientSecret, refreshToken } = resolveCreds();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(
      `token refresh failed (HTTP ${res.status}): ${data.error || 'unknown'} — ${data.error_description || ''}`.trim() +
      (data.error === 'invalid_grant' ? '\nThe stored refresh token was revoked or expired. Run `gdoc auth` again.' : '')
    );
  }
  writeTokenCache({
    access_token: data.access_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600) - 60,
  });
  return data.access_token;
}

// Returns a valid access token, refreshing only when the cached one is stale.
export async function getAccessToken() {
  const cache = readTokenCache();
  if (cache?.access_token && cache.expires_at > Math.floor(Date.now() / 1000)) {
    return cache.access_token;
  }
  return refresh();
}
