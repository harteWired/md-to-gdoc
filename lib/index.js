// Public library entry point.
//
// The star of the package is `mdToDoc` — a pure, dependency-free function that
// turns markdown into Google Docs `batchUpdate` requests. It is
// transport-agnostic: feed the requests to the official `googleapis` client,
// raw fetch, the `gws` CLI, or anything else that speaks the Docs API.
//
//   import { mdToDoc } from '@hartewired/md-to-gdoc';
//   const { title, requests, tables } = mdToDoc('# Hello\n\nWorld **bold**');
//   // 1. create a doc with `title`
//   // 2. documents.batchUpdate({ documentId, requestBody: { requests } })
//   // 3. build `tables` in a second pass (see README / bin/gdoc.js)
//
// The lower-level parsers and request-shaping helpers are exported too, for
// callers that want to build their own pipeline.

export {
  mdToDoc,
  parseInline,
  parseBlocks,
  splitLargeInserts,
  rebaseIndices,
} from './md-to-docs.js';
