// Configuration + credential resolution for the `gdoc` CLI.
//
// Multi-account. The config file (default ~/.config/md-to-gdoc/config.json,
// override with $GDOC_CONFIG) holds named accounts:
//
//   {
//     "default": "personal",
//     "accounts": {
//       "personal": { "client_id": "...", "client_secret": "...", "refresh_token": "..." },
//       "work":     { "client_id": "...", "client_secret": "...", "refresh_token": "..." }
//     }
//   }
//
// A legacy flat file ({ "client_id", "client_secret", "refresh_token" }) is
// still honored and treated as the account named "default".
//
// The active account is picked by (in order): the --account flag, the config
// "default", then "default". Env vars (GDOC_CLIENT_ID / _CLIENT_SECRET /
// _REFRESH_TOKEN) override per-field for whichever account is active — handy
// for single-account CI.
//
// Note: the CLI is optional. The library entry (`mdToDoc`) needs none of this —
// it just builds the Docs requests; you send them with whatever client you like.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync,
} from 'node:fs';

// --- paths (lazy: read env at call time, so tests/overrides work) -----------
export function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'md-to-gdoc');
}
export function configPath() {
  return process.env.GDOC_CONFIG || join(configDir(), 'config.json');
}
const sanitize = (name) => name.replace(/[^a-zA-Z0-9_-]/g, '_');
export function tokenPath(account) {
  return join(configDir(), `token-${sanitize(account || activeAccount())}.json`);
}

function ensureDir() {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
}

export function loadConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

// --- active-account selection -----------------------------------------------
let _account = null;
export function setAccount(name) { _account = name || null; }

export function activeAccount() {
  if (_account) return _account;
  const cfg = loadConfig();
  return cfg.default || 'default';
}

export function listAccounts() {
  const cfg = loadConfig();
  if (cfg.accounts) return Object.keys(cfg.accounts);
  if (cfg.client_id || cfg.refresh_token) return ['default']; // legacy flat
  return [];
}

// Per-account stored credentials from the file (no env), or {} if none.
function fileCredsFor(name) {
  const cfg = loadConfig();
  if (cfg.accounts?.[name]) return cfg.accounts[name];
  // Legacy flat file counts as the "default" account.
  if (!cfg.accounts && name === 'default' && (cfg.client_id || cfg.refresh_token)) {
    return { client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token };
  }
  return {};
}

// Write credentials for a named account, migrating a legacy flat file into the
// accounts map on first multi-account write. Sets `default` if unset.
export function saveAccount(name, creds) {
  ensureDir();
  const cfg = loadConfig();
  if (!cfg.accounts) {
    cfg.accounts = {};
    if (cfg.client_id || cfg.refresh_token) {
      cfg.accounts.default = { client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token };
    }
  }
  delete cfg.client_id; delete cfg.client_secret; delete cfg.refresh_token;
  cfg.accounts[name] = { ...cfg.accounts[name], ...creds };
  if (!cfg.default) cfg.default = name;
  const path = configPath();
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  if (existsSync(path)) chmodSync(path, 0o600);
  return cfg;
}

// --- credential resolution --------------------------------------------------
// Resolve { account, clientId, clientSecret, refreshToken } for the active
// account. `requireToken=false` skips the refresh-token requirement (used by
// `gdoc auth`, which is minting one).
export function resolveCreds({ requireToken = true } = {}) {
  const account = activeAccount();
  const fc = fileCredsFor(account);
  const clientId = process.env.GDOC_CLIENT_ID || fc.client_id;
  const clientSecret = process.env.GDOC_CLIENT_SECRET || fc.client_secret;
  const refreshToken = process.env.GDOC_REFRESH_TOKEN || fc.refresh_token;

  if (!clientId || !clientSecret) {
    throw new Error(
      `no OAuth client for account "${account}". Set GDOC_CLIENT_ID / GDOC_CLIENT_SECRET, ` +
      `or run \`gdoc auth --account ${account} --client-id … --client-secret …\`. See README "Setup".`
    );
  }
  if (requireToken && !refreshToken) {
    throw new Error(
      `account "${account}" is not authenticated. Run \`gdoc auth --account ${account}\`, ` +
      'or set GDOC_REFRESH_TOKEN. See README "Authentication".'
    );
  }
  return { account, clientId, clientSecret, refreshToken };
}

// --- token cache ------------------------------------------------------------
export function readTokenCache() {
  try {
    return JSON.parse(readFileSync(tokenPath(), 'utf8'));
  } catch {
    return null;
  }
}

export function writeTokenCache(obj) {
  ensureDir();
  const path = tokenPath();
  writeFileSync(path, JSON.stringify(obj), { mode: 0o600 });
  if (existsSync(path)) chmodSync(path, 0o600);
}
