// Thin wrapper over the Google Docs REST API. Talks to Google directly with a
// bearer token from auth.js — no external binary, no daemon. Because the
// request body travels in the HTTP body (not argv), there is no per-arg size
// limit to work around; the whole batchUpdate goes in one call.

import { getAccessToken } from './auth.js';

const BASE = 'https://docs.googleapis.com/v1';

async function docs(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    throw new Error(`Docs API ${method} ${path} failed (HTTP ${res.status}): ${msg}`);
  }
  return data;
}

export async function createDoc(title) {
  const res = await docs('POST', '/documents', { title });
  if (!res.documentId) throw new Error(`create returned no documentId: ${JSON.stringify(res).slice(0, 200)}`);
  return res.documentId;
}

export function getDoc(documentId) {
  return docs('GET', `/documents/${documentId}`);
}

export function batchUpdate(documentId, requests) {
  return docs('POST', `/documents/${documentId}:batchUpdate`, { requests });
}
