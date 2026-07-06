// Interactive OAuth for `gdoc auth`. Two modes:
//   - loopback (default): spin a localhost server, open the browser, capture the
//     redirect automatically.
//   - manual (--manual): print the URL, user pastes back the `code`. For
//     headless / remote machines with no local browser.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { TOKEN_ENDPOINT } from './auth.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

// The Docs scope covers create + edit of the user's Google Docs — everything
// `gdoc` needs to create a doc and (with --doc-id) append to an existing one.
export const SCOPES = [
  'https://www.googleapis.com/auth/documents',
];

function buildAuthUrl({ clientId, redirectUri, state }) {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline'); // request a refresh token
  u.searchParams.set('prompt', 'consent'); // force refresh_token every time
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    throw new Error(
      `code exchange failed (HTTP ${res.status}): ${data.error || 'unknown'} — ${data.error_description || ''}`.trim() +
      (!data.refresh_token && res.ok ? '\nNo refresh_token returned — revoke prior access at myaccount.google.com and retry (prompt=consent is set).' : '')
    );
  }
  return data.refresh_token;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// Manual flow: fixed loopback URI the user completes anywhere, then pastes the
// code. Uses http://127.0.0.1 as redirect (must be registered on the OAuth
// client) — the browser lands on a "can't connect" page whose URL carries
// ?code=...; the user copies that code.
async function manualFlow({ clientId, clientSecret }) {
  const redirectUri = 'http://127.0.0.1';
  const url = buildAuthUrl({ clientId, redirectUri });
  console.log('\nOpen this URL in any browser, approve access, then copy the `code`');
  console.log('value from the address bar of the page you land on:\n');
  console.log(url + '\n');
  const code = await prompt('Paste the code here: ');
  if (!code) throw new Error('no code provided');
  return exchangeCode({ code, clientId, clientSecret, redirectUri });
}

// Loopback flow: capture the redirect on a local port automatically.
function loopbackFlow({ clientId, clientSecret }) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1`);
        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font-family:sans-serif;padding:2rem"><h2>${err ? 'Authorization failed' : 'Authorized — you can close this tab.'}</h2></body></html>`);
        server.close();
        if (err) return reject(new Error(`authorization denied: ${err}`));
        if (!code) return reject(new Error('no code in redirect'));
        const port = server.address().port;
        const refreshToken = await exchangeCode({
          code, clientId, clientSecret, redirectUri: `http://127.0.0.1:${port}`,
        });
        resolve(refreshToken);
      } catch (e) {
        reject(e);
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const url = buildAuthUrl({ clientId, redirectUri });
      console.log('\nOpening your browser to authorize md-to-gdoc...');
      console.log('If it does not open, visit this URL manually:\n');
      console.log(url + '\n');
      openBrowser(url);
    });
  });
}

// Run the interactive grant and return a refresh token.
export function authorize({ clientId, clientSecret, manual }) {
  return manual
    ? manualFlow({ clientId, clientSecret })
    : loopbackFlow({ clientId, clientSecret });
}
