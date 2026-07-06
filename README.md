# @hartewired/md-to-gdoc

Turn **markdown** into a nicely formatted **Google Doc**.

The Google Docs API is index-based: you insert plain text, then style it by
character range — computing every offset by hand, and re-deriving them whenever
text shifts. `md-to-gdoc` does that arithmetic for you. The core is a **pure,
zero-dependency function** that converts markdown into Docs `batchUpdate`
requests; a small CLI is included for the common "markdown file → new doc" case.

## Library

```bash
npm install @hartewired/md-to-gdoc
```

```js
import { mdToDoc } from '@hartewired/md-to-gdoc';

const { title, requests, tables } = mdToDoc('# Report\n\nHello **world**.');
// title    -> "Report"
// requests -> Docs API batchUpdate requests (headings, styles, lists, ...)
// tables   -> table specs for a second pass (see "Tables" below)
```

`mdToDoc` is **transport-agnostic** — it never talks to Google. Feed `requests`
to whatever Docs client you already use. With the official `googleapis`:

```js
import { google } from 'googleapis';
const docsApi = google.docs({ version: 'v1', auth });

const { title, requests } = mdToDoc(markdown);
const { data } = await docsApi.documents.create({ requestBody: { title } });
await docsApi.documents.batchUpdate({
  documentId: data.documentId,
  requestBody: { requests },
});
```

That's the whole integration for table-free docs. Tables need a short second
pass because `insertTable` rewrites cell indices — see [`bin/gdoc.js`](./bin/gdoc.js)
(`buildTables`) for a reference implementation you can copy.

### Exports

- `mdToDoc(markdown, { title? })` → `{ title, text, requests, tables }`
- `parseInline(str)` / `parseBlocks(markdown)` — the underlying parsers
- `splitLargeInserts(requests, maxBytes?)` — split an oversized `insertText`
  (useful when your transport has an argv/line-length limit, e.g. shelling a CLI)
- `rebaseIndices(node, delta)` — shift every index to append into an existing doc

## CLI

The package also ships a stateless `gdoc` command that creates the doc for you.

```bash
gdoc notes.md                     # -> prints the new doc's URL
gdoc notes.md --title "Q3 Plan"   # override the title
gdoc notes.md --json              # -> {documentId,url,title}
cat notes.md | gdoc               # read from stdin
gdoc notes.md --doc-id <ID>       # append into an existing doc
gdoc notes.md --dry-run           # print the batchUpdate requests only
```

### Setup

1. Create an OAuth client (Desktop app) in a Google Cloud project with the
   **Google Docs API** enabled. Add `http://127.0.0.1` to its authorized
   redirect URIs.
2. Authenticate:

   ```bash
   gdoc auth --client-id <ID> --client-secret <SECRET>
   # headless / remote box with no browser:
   gdoc auth --manual --client-id <ID> --client-secret <SECRET>
   ```

   This stores a refresh token in `~/.config/md-to-gdoc/config.json` (mode 600).
   Multiple accounts are supported: `gdoc auth --account work …`, then
   `gdoc notes.md --account work`. `gdoc accounts` lists them.

Credentials can also come from the environment (handy for CI):
`GDOC_CLIENT_ID`, `GDOC_CLIENT_SECRET`, `GDOC_REFRESH_TOKEN`.

## Supported markdown

Headings (`#`..`######`; the first `#` becomes the doc title with TITLE style),
**bold** / _italic_ / ~~strikethrough~~ / `inline code`, `[links](url)`,
bulleted and numbered lists, fenced code blocks, blockquotes, horizontal rules,
and pipe tables (with a bold header row).

Not yet: nested lists, inline markdown inside table cells, images, page breaks.

## Design

`lib/md-to-docs.js` accumulates the whole document as one plain-text string,
tracks the offset of every styled run and paragraph, then emits **one**
`insertText` followed by styling requests that never change the text length — so
every index stays valid without reflow bookkeeping. Indices are UTF-16 code
units, exactly what the Docs API expects. It is fully unit-tested (`npm test`).

## License

MIT
