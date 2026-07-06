#!/usr/bin/env node
// gdoc — turn markdown into a nicely formatted Google Doc.
//
// A thin CLI over the pure `mdToDoc` converter. It parses markdown, computes the
// Docs API batchUpdate requests (the painful index math), and applies them via
// the Docs REST API. Stateless, zero-dependency, JSON output on request.
//
// Usage:
//   gdoc <file.md> [--title "Title"] [--doc-id ID] [--json] [--dry-run] [--account N]
//   gdoc --stdin [--title "Title"]            # read markdown from stdin
//   cat notes.md | gdoc                        # ditto
//   gdoc auth [--account N] [--manual] [--client-id ID --client-secret SECRET]
//   gdoc accounts

import { readFileSync } from 'node:fs';
import { parseArgs } from '../lib/args.js';
import { mdToDoc, rebaseIndices } from '../lib/md-to-docs.js';
import { createDoc, getDoc, batchUpdate } from '../lib/api.js';
import {
  setAccount, activeAccount, listAccounts, saveAccount, resolveCreds,
} from '../lib/config.js';
import { authorize } from '../lib/oauth.js';

const HELP = `gdoc — markdown -> Google Doc

  gdoc <file.md> [--title "Title"] [--doc-id ID] [--json] [--dry-run] [--account N]
  gdoc --stdin [--title "Title"]
  cat notes.md | gdoc

Auth:
  gdoc auth [--account N] [--manual] [--client-id ID --client-secret SECRET]
  gdoc accounts

Flags:
  --title T      Override the doc title (default: first # heading)
  --doc-id ID    Append the rendered markdown to an existing doc
  --account N    Use a named account (default: config "default")
  --json         Print {documentId,url,title} as JSON
  --dry-run      Print the computed batchUpdate requests; make no API calls
`;

// --- table second pass ------------------------------------------------------
// insertTable rewrites cell indices, so tables can't ride in the text insert.
// Insert each table bottom-to-top (earlier anchors stay valid), re-fetch to
// learn the real cell indices, fill cells highest-index-first, bold the header.
async function buildTables(documentId, tables) {
  for (const t of [...tables].sort((a, b) => b.anchorIndex - a.anchorIndex)) {
    const cols = Math.max(...t.rows.map((r) => r.length));
    const rows = t.rows.length;
    await batchUpdate(documentId, [{
      insertTable: { rows, columns: cols, location: { index: t.anchorIndex } },
    }]);

    const tableEl = findTableAt(await getDoc(documentId), t.anchorIndex);
    if (!tableEl) throw new Error(`could not locate inserted table at index ${t.anchorIndex}`);

    const fills = [];
    tableEl.table.tableRows.forEach((row, r) => {
      row.tableCells.forEach((cell, c) => {
        const text = (t.rows[r] && t.rows[r][c]) || '';
        if (!text) return;
        fills.push({ index: cell.content[0].startIndex, text, header: r === 0 });
      });
    });
    fills.sort((a, b) => b.index - a.index);
    if (fills.length) {
      await batchUpdate(documentId, fills.map((f) => ({
        insertText: { location: { index: f.index }, text: f.text },
      })));
    }

    const fresh = findTableAt(await getDoc(documentId), t.anchorIndex);
    const boldReqs = [];
    fresh.table.tableRows[0].tableCells.forEach((cell, c) => {
      const text = (t.rows[0] && t.rows[0][c]) || '';
      if (!text) return;
      const start = cell.content[0].startIndex;
      boldReqs.push({
        updateTextStyle: {
          range: { startIndex: start, endIndex: start + text.length },
          textStyle: { bold: true },
          fields: 'bold',
        },
      });
    });
    if (boldReqs.length) await batchUpdate(documentId, boldReqs);
  }
}

function findTableAt(doc, anchorIndex) {
  const content = doc?.body?.content || [];
  let best = null;
  for (const el of content) {
    if (el.table && el.startIndex >= anchorIndex) {
      if (!best || el.startIndex < best.startIndex) best = el;
    }
  }
  return best;
}

function endInsertIndex(doc) {
  const content = doc?.body?.content || [];
  const last = content[content.length - 1];
  const end = last?.endIndex || 2;
  return end - 1;
}

// --- subcommands ------------------------------------------------------------
async function cmdAuth(flags) {
  if (flags.account) setAccount(flags.account);
  const account = activeAccount();
  // client id/secret from flags, env, or an existing config entry
  let clientId = flags['client-id'];
  let clientSecret = flags['client-secret'];
  if (!clientId || !clientSecret) {
    try {
      const c = resolveCreds({ requireToken: false });
      clientId = clientId || c.clientId;
      clientSecret = clientSecret || c.clientSecret;
    } catch { /* fall through to the error below */ }
  }
  if (!clientId || !clientSecret) {
    throw new Error('need --client-id and --client-secret (or GDOC_CLIENT_ID / GDOC_CLIENT_SECRET). See README "Setup".');
  }
  const refreshToken = await authorize({ clientId, clientSecret, manual: !!flags.manual });
  saveAccount(account, { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken });
  process.stdout.write(`Authorized account "${account}". Credentials saved.\n`);
}

function cmdAccounts() {
  const accts = listAccounts();
  const active = activeAccount();
  if (!accts.length) { process.stdout.write('No accounts configured. Run `gdoc auth`.\n'); return; }
  for (const a of accts) process.stdout.write(`${a === active ? '* ' : '  '}${a}\n`);
}

function readInput(flags, file) {
  if (file) return readFileSync(file, 'utf8');
  if (flags.stdin || !process.stdin.isTTY) return readFileSync(0, 'utf8');
  throw new Error('no input: pass a markdown file, --stdin, or pipe markdown in');
}

async function cmdRender(flags, file) {
  if (flags.account) setAccount(flags.account);
  const md = readInput(flags, file);
  const built = mdToDoc(md, { title: flags.title === true ? undefined : flags.title });

  let documentId = flags['doc-id'] === true ? undefined : flags['doc-id'];
  let requests = built.requests;
  let tables = built.tables;

  if (documentId) {
    const delta = endInsertIndex(await getDoc(documentId)) - 1;
    if (delta > 0) {
      requests = rebaseIndices(requests, delta);
      tables = tables.map((t) => ({ ...t, anchorIndex: t.anchorIndex + delta }));
    }
  }

  if (flags['dry-run']) {
    process.stdout.write(JSON.stringify({ title: built.title, requests, tables }, null, 2) + '\n');
    return;
  }

  if (!documentId) documentId = await createDoc(built.title);
  if (requests.length) await batchUpdate(documentId, requests);
  if (tables.length) await buildTables(documentId, tables);

  const url = `https://docs.google.com/document/d/${documentId}/edit`;
  if (flags.json) process.stdout.write(JSON.stringify({ documentId, url, title: built.title }) + '\n');
  else process.stdout.write(`Created "${built.title}"\n${url}\n`);
}

// --- main -------------------------------------------------------------------
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) { process.stdout.write(HELP); return; }

  const sub = positional[0];
  if (sub === 'auth') return cmdAuth(flags);
  if (sub === 'accounts') return cmdAccounts();
  return cmdRender(flags, sub); // sub is the file path (or undefined for stdin)
}

main().catch((e) => {
  process.stderr.write(`gdoc: ${e.message}\n`);
  process.exit(1);
});
