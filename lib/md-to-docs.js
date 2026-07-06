// Markdown -> Google Docs `batchUpdate` request builder.
//
// The Docs API is index-based: you insert plain text, then style it by
// character range. Authoring those ranges by hand is brutal, so this module
// does the index math for you. It is pure and side-effect-free — given a
// markdown string it returns { title, text, requests, tables }, which the
// driver (bin/gdoc) feeds to `gws docs documents create` + `batchUpdate`.
//
// Strategy: accumulate the whole document as one plain-text string, tracking
// the offset of every styled run and every paragraph. Then emit a single
// insertText at index 1 followed by styling requests (updateParagraphStyle,
// updateTextStyle, createParagraphBullets) that reference the computed ranges.
// Because none of those styling requests change the text length, all indices
// stay valid — no reflow bookkeeping.
//
// Indices are UTF-16 code units, which is exactly String#length in JS, so the
// math is 1:1 for the ASCII + BMP content these docs contain.

const PT = (magnitude) => ({ magnitude, unit: 'PT' });
const GRAY = { color: { rgbColor: { red: 0.4, green: 0.4, blue: 0.4 } } };
const CODE_BG = { color: { rgbColor: { red: 0.96, green: 0.96, blue: 0.96 } } };
const RULE = { color: { rgbColor: { red: 0.8, green: 0.8, blue: 0.8 } } };
const CODE_FONT = 'Consolas';

// --- inline markdown -> styled runs -----------------------------------------
// Returns { text, runs } where runs = [{ start, end, style }] and style is one
// of { bold }, { italic }, { code }, { strike }, { link }. Nesting is handled
// by recursion, so `**bold with `code`**` yields both a bold run and a code run.
export function parseInline(src) {
  const runs = [];
  let text = '';
  let i = 0;
  const n = src.length;

  const nested = (inner, style) => {
    const sub = parseInline(inner);
    const base = text.length;
    text += sub.text;
    runs.push({ start: base, end: text.length, style });
    for (const r of sub.runs) runs.push({ start: base + r.start, end: base + r.end, style: r.style });
  };

  while (i < n) {
    const c = src[i];

    // `code` — literal, no nested parsing
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end !== -1) {
        const s = text.length;
        text += src.slice(i + 1, end);
        runs.push({ start: s, end: text.length, style: { code: true } });
        i = end + 1;
        continue;
      }
    }
    // **bold** / __bold__
    if ((c === '*' && src[i + 1] === '*') || (c === '_' && src[i + 1] === '_')) {
      const delim = c + c;
      const end = src.indexOf(delim, i + 2);
      if (end !== -1) {
        nested(src.slice(i + 2, end), { bold: true });
        i = end + 2;
        continue;
      }
    }
    // ~~strike~~
    if (c === '~' && src[i + 1] === '~') {
      const end = src.indexOf('~~', i + 2);
      if (end !== -1) {
        nested(src.slice(i + 2, end), { strike: true });
        i = end + 2;
        continue;
      }
    }
    // *italic* / _italic_
    if (c === '*' || c === '_') {
      const end = src.indexOf(c, i + 1);
      if (end > i + 1) {
        nested(src.slice(i + 1, end), { italic: true });
        i = end + 1;
        continue;
      }
    }
    // [label](url)
    if (c === '[') {
      const close = src.indexOf(']', i + 1);
      if (close !== -1 && src[close + 1] === '(') {
        const paren = src.indexOf(')', close + 2);
        if (paren !== -1) {
          nested(src.slice(i + 1, close), { link: src.slice(close + 2, paren) });
          i = paren + 1;
          continue;
        }
      }
    }
    text += c;
    i++;
  }
  return { text, runs };
}

// --- block parsing ----------------------------------------------------------
// Returns an array of block objects. Each is one of:
//   { type: 'heading', level, text }
//   { type: 'para', text }
//   { type: 'list', ordered, items: [text, ...] }
//   { type: 'code', lines: [str, ...] }
//   { type: 'quote', text }
//   { type: 'hr' }
//   { type: 'table', rows: [[cell, ...], ...] }
export function parseBlocks(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  const isTableSep = (s) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s);
  const splitRow = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') { i++; continue; }

    // fenced code
    const fence = line.match(/^\s*```/);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // closing fence
      blocks.push({ type: 'code', lines: code });
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() }); i++; continue; }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    // table: a header row followed by a separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const rows = [splitRow(line)];
      i += 2; // skip header + separator
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', rows });
      continue;
    }

    // blockquote (consecutive `>` lines join into one paragraph)
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: buf.join(' ').trim() });
      continue;
    }

    // list (contiguous run of unordered or ordered items)
    const li = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d+\./.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
        if (!m) break;
        if (/\d+\./.test(m[1]) !== ordered) break; // list type switch ends the run
        items.push(m[2].trim());
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // paragraph: gather consecutive plain lines (soft-wrapped into one para)
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' &&
      !/^(#{1,6})\s/.test(lines[i]) && !/^\s*```/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      buf.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'para', text: buf.join(' ') });
  }
  return blocks;
}

const NAMED_STYLE = { 1: 'HEADING_1', 2: 'HEADING_2', 3: 'HEADING_3', 4: 'HEADING_4', 5: 'HEADING_5', 6: 'HEADING_6' };

// Translate an inline run's style into an updateTextStyle request over [s, e).
function textStyleRequest(s, e, style) {
  const range = { startIndex: s, endIndex: e };
  if (style.bold) return { updateTextStyle: { range, textStyle: { bold: true }, fields: 'bold' } };
  if (style.italic) return { updateTextStyle: { range, textStyle: { italic: true }, fields: 'italic' } };
  if (style.strike) return { updateTextStyle: { range, textStyle: { strikethrough: true }, fields: 'strikethrough' } };
  if (style.code) {
    return {
      updateTextStyle: {
        range,
        textStyle: {
          weightedFontFamily: { fontFamily: CODE_FONT },
          backgroundColor: { color: CODE_BG.color },
        },
        fields: 'weightedFontFamily,backgroundColor',
      },
    };
  }
  if (style.link) {
    return {
      updateTextStyle: {
        range,
        textStyle: { link: { url: style.link }, foregroundColor: { color: { rgbColor: { red: 0.06, green: 0.33, blue: 0.8 } } }, underline: true },
        fields: 'link,foregroundColor,underline',
      },
    };
  }
  return null;
}

// --- main builder -----------------------------------------------------------
// mdToDoc(markdown, { title }) -> { title, text, requests, tables }
//   text     : the full plain-text body inserted at index 1 (tables excluded)
//   requests : batchUpdate requests to run AFTER the text insert
//   tables   : [{ anchorIndex, rows }] handled by the driver in a second pass
export function mdToDoc(md, opts = {}) {
  const blocks = parseBlocks(md);

  let text = '';
  const styleReqs = []; // updateTextStyle
  const paraReqs = [];  // updateParagraphStyle
  const bulletReqs = []; // createParagraphBullets
  const tables = [];

  // Append one paragraph of plain text (+ trailing newline). Returns the
  // document index range { start, end } where start is the paragraph's first
  // char and end is just past its newline.
  const addParagraph = (plain) => {
    const start = 1 + text.length;
    text += plain + '\n';
    const end = 1 + text.length;
    return { start, end };
  };

  // Emit inline text-style requests for runs within a paragraph starting at docStart.
  const addRuns = (docStart, runs) => {
    for (const r of runs) {
      const req = textStyleRequest(docStart + r.start, docStart + r.end, r.style);
      if (req) styleReqs.push(req);
    }
  };

  let firstHeadingText = null;

  blocks.forEach((block, idx) => {
    switch (block.type) {
      case 'heading': {
        const { text: plain, runs } = parseInline(block.text);
        if (firstHeadingText === null && block.level === 1) firstHeadingText = plain;
        const { start, end } = addParagraph(plain);
        addRuns(start, runs);
        // First block, top-level heading -> TITLE style for a proper doc title.
        const named = idx === 0 && block.level === 1 ? 'TITLE' : NAMED_STYLE[block.level];
        paraReqs.push({
          updateParagraphStyle: {
            range: { startIndex: start, endIndex: end },
            paragraphStyle: { namedStyleType: named },
            fields: 'namedStyleType',
          },
        });
        break;
      }

      case 'para': {
        const { text: plain, runs } = parseInline(block.text);
        const { start } = addParagraph(plain);
        addRuns(start, runs);
        break;
      }

      case 'list': {
        let runStart = null;
        let runEnd = null;
        for (const item of block.items) {
          const { text: plain, runs } = parseInline(item);
          const { start, end } = addParagraph(plain);
          addRuns(start, runs);
          if (runStart === null) runStart = start;
          runEnd = end;
        }
        bulletReqs.push({
          createParagraphBullets: {
            range: { startIndex: runStart, endIndex: runEnd },
            bulletPreset: block.ordered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
          },
        });
        break;
      }

      case 'code': {
        const lines = block.lines.length ? block.lines : [''];
        let blockStart = null;
        let blockEnd = null;
        for (const ln of lines) {
          const { start, end } = addParagraph(ln); // literal, no inline parsing
          if (blockStart === null) blockStart = start;
          blockEnd = end;
        }
        paraReqs.push({
          updateParagraphStyle: {
            range: { startIndex: blockStart, endIndex: blockEnd },
            paragraphStyle: {
              shading: { backgroundColor: { color: CODE_BG.color } },
              indentStart: PT(18),
              indentFirstLine: PT(18),
            },
            fields: 'shading,indentStart,indentFirstLine',
          },
        });
        styleReqs.push({
          updateTextStyle: {
            range: { startIndex: blockStart, endIndex: blockEnd - 1 },
            textStyle: { weightedFontFamily: { fontFamily: CODE_FONT }, fontSize: PT(10) },
            fields: 'weightedFontFamily,fontSize',
          },
        });
        break;
      }

      case 'quote': {
        const { text: plain, runs } = parseInline(block.text);
        const { start, end } = addParagraph(plain);
        addRuns(start, runs);
        paraReqs.push({
          updateParagraphStyle: {
            range: { startIndex: start, endIndex: end },
            paragraphStyle: {
              indentStart: PT(36),
              indentFirstLine: PT(36),
              borderLeft: { color: RULE, width: PT(3), padding: PT(8), dashStyle: 'SOLID' },
            },
            fields: 'indentStart,indentFirstLine,borderLeft',
          },
        });
        styleReqs.push({
          updateTextStyle: {
            range: { startIndex: start, endIndex: end - 1 },
            textStyle: { italic: true, foregroundColor: { color: GRAY.color } },
            fields: 'italic,foregroundColor',
          },
        });
        break;
      }

      case 'hr': {
        const { start, end } = addParagraph('');
        paraReqs.push({
          updateParagraphStyle: {
            range: { startIndex: start, endIndex: end },
            paragraphStyle: {
              borderBottom: { color: RULE, width: PT(1), padding: PT(4), dashStyle: 'SOLID' },
            },
            fields: 'borderBottom',
          },
        });
        break;
      }

      case 'table': {
        // Tables need a second pass (the driver inserts + fills them), because
        // insertTable rewrites cell indices. Leave an empty anchor paragraph
        // and hand the driver the anchor index + cell text.
        const { start } = addParagraph('');
        tables.push({ anchorIndex: start, rows: block.rows });
        break;
      }
    }
  });

  // Order: paragraph styles, then bullets, then text styles. None shift indices.
  const requests = [];
  if (text.length) requests.push({ insertText: { location: { index: 1 }, text } });
  requests.push(...paraReqs, ...bulletReqs, ...styleReqs);

  const title = opts.title || firstHeadingText || 'Untitled Document';
  return { title, text, requests, tables };
}

// --- request-shaping utilities (used by the driver) -------------------------

// Split a string into pieces each <= maxBytes (UTF-8), never splitting a code
// point. Returns [] for empty input.
function splitByBytes(str, maxBytes) {
  const pieces = [];
  let buf = '';
  let bytes = 0;
  for (const ch of str) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > maxBytes && buf) { pieces.push(buf); buf = ''; bytes = 0; }
    buf += ch;
    bytes += b;
  }
  if (buf) pieces.push(buf);
  return pieces;
}

// A single insertText whose body exceeds the argv limit can't be passed to gws.
// Split it into several inserts at cumulative indices — the result is identical
// to one big insert, since each piece lands right after the previous one.
export function splitLargeInserts(requests, maxBytes = 90_000) {
  const out = [];
  for (const req of requests) {
    if (req.insertText && Buffer.byteLength(req.insertText.text) > maxBytes) {
      let idx = req.insertText.location.index;
      for (const piece of splitByBytes(req.insertText.text, maxBytes)) {
        out.push({ insertText: { location: { index: idx }, text: piece } });
        idx += piece.length; // UTF-16 code units — what Docs indexes by
      }
    } else {
      out.push(req);
    }
  }
  return out;
}

// Shift every document index in a request tree by `delta`. Used to append a
// rendered fragment into an existing doc at a non-1 base index.
export function rebaseIndices(node, delta) {
  if (Array.isArray(node)) return node.map((n) => rebaseIndices(n, delta));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = (k === 'index' || k === 'startIndex' || k === 'endIndex') && typeof v === 'number'
        ? v + delta
        : rebaseIndices(v, delta);
    }
    return out;
  }
  return node;
}
