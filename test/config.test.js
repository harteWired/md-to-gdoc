import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.js reads env lazily, so point it at a throwaway config file per test.
let dir;
let cfgPath;
let config;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'md-to-gdoc-test-'));
  cfgPath = join(dir, 'config.json');
  process.env.GDOC_CONFIG = cfgPath;
  delete process.env.GDOC_CLIENT_ID;
  delete process.env.GDOC_CLIENT_SECRET;
  delete process.env.GDOC_REFRESH_TOKEN;
  // fresh module each test so the in-memory _account resets
  config = await import(`../lib/config.js?${Math.random()}`);
  config.setAccount(null);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.GDOC_CONFIG;
});

test('activeAccount defaults to "default" with no config', () => {
  assert.equal(config.activeAccount(), 'default');
  assert.deepEqual(config.listAccounts(), []);
});

test('saveAccount writes an accounts map and sets default', () => {
  config.saveAccount('personal', { client_id: 'cid', client_secret: 'sec', refresh_token: 'rt' });
  const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(written.default, 'personal');
  assert.equal(written.accounts.personal.client_id, 'cid');
  assert.deepEqual(config.listAccounts(), ['personal']);
});

test('legacy flat config is treated as the "default" account', () => {
  writeFileSync(cfgPath, JSON.stringify({ client_id: 'c', client_secret: 's', refresh_token: 'r' }));
  assert.deepEqual(config.listAccounts(), ['default']);
  const creds = config.resolveCreds();
  assert.equal(creds.account, 'default');
  assert.equal(creds.refreshToken, 'r');
});

test('saveAccount migrates a legacy flat file into the accounts map', () => {
  writeFileSync(cfgPath, JSON.stringify({ client_id: 'c', client_secret: 's', refresh_token: 'r' }));
  config.saveAccount('work', { client_id: 'c2', client_secret: 's2', refresh_token: 'r2' });
  const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(written.accounts.default.client_id, 'c'); // legacy preserved
  assert.equal(written.accounts.work.client_id, 'c2');
  assert.equal(written.client_id, undefined); // flat keys removed
});

test('env vars override file credentials for the active account', () => {
  config.saveAccount('personal', { client_id: 'cid', client_secret: 'sec', refresh_token: 'rt' });
  process.env.GDOC_REFRESH_TOKEN = 'from-env';
  const creds = config.resolveCreds();
  assert.equal(creds.refreshToken, 'from-env');
});

test('resolveCreds throws a helpful error when unconfigured', () => {
  assert.throws(() => config.resolveCreds(), /no OAuth client for account "default"/);
});

test('resolveCreds({requireToken:false}) allows a missing refresh token', () => {
  process.env.GDOC_CLIENT_ID = 'cid';
  process.env.GDOC_CLIENT_SECRET = 'sec';
  const creds = config.resolveCreds({ requireToken: false });
  assert.equal(creds.clientId, 'cid');
  assert.equal(creds.refreshToken, undefined);
});
