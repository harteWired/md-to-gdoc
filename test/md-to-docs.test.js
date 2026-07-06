import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInline, parseBlocks, mdToDoc, splitLargeInserts, rebaseIndices,
} from '../lib/md-to-docs.js';

// --- inline parsing ---------------------------------------------------------
test('inline: plain text has no runs', () => {
  const { text, runs } = parseInline('just words');
  assert.equal(text, 'just words');
  assert.equal(runs.length, 0);
});

test('inline: bold/italic/code strip delimiters and mark ranges', () => {
  const { text, runs } = parseInline('a **b** _c_ `d`');
  assert.equal(text, 'a b c d');
  const bold = runs.find((r) => r.style.bold);
  assert.deepEqual([bold.start, bold.end], [2, 3]);
  assert.equal(text.slice(bold.start, bold.end), 'b');
  const code = runs.find((r) => r.style.code);
  assert.equal(text.slice(code.start, code.end), 'd');
});

test('inline: link captures url and label', () => {
  const { text, runs } = parseInline('see [the docs](https://x.y) now');
  assert.equal(text, 'see the docs now');
  const link = runs.find((r) => r.style.link);
  assert.equal(link.style.link, 'https://x.y');
  assert.equal(text.slice(link.start, link.end), 'the docs');
});

test('inline: nested code inside bold yields both runs', () => {
  const { text, runs } = parseInline('**bold `x` end**');
  assert.equal(text, 'bold x end');
  assert.ok(runs.some((r) => r.style.bold && r.start === 0 && r.end === 10));
  assert.ok(runs.some((r) => r.style.code && text.slice(r.start, r.end) === 'x'));
});

// --- block parsing ----------------------------------------------------------
test('blocks: headings, lists, code, quote, hr, table', () => {
  const md = [
    '# Title', '', 'A paragraph.', '',
    '- one', '- two', '',
    '1. first', '2. second', '',
    '```', 'code line', '```', '',
    '> a quote', '', '---', '',
    '| A | B |', '| - | - |', '| 1 | 2 |',
  ].join('\n');
  const b = parseBlocks(md);
  assert.equal(b[0].type, 'heading');
  assert.equal(b[0].level, 1);
  assert.equal(b[1].type, 'para');
  assert.equal(b[2].type, 'list');
  assert.equal(b[2].ordered, false);
  assert.deepEqual(b[2].items, ['one', 'two']);
  assert.equal(b[3].ordered, true);
  assert.equal(b[4].type, 'code');
  assert.deepEqual(b[4].lines, ['code line']);
  assert.equal(b[5].type, 'quote');
  assert.equal(b[6].type, 'hr');
  assert.equal(b[7].type, 'table');
  assert.deepEqual(b[7].rows, [['A', 'B'], ['1', '2']]);
});

test('blocks: soft-wrapped lines join into one paragraph', () => {
  const b = parseBlocks('line one\nline two\n\nnext');
  assert.equal(b.length, 2);
  assert.equal(b[0].text, 'line one line two');
});

// --- mdToDoc ----------------------------------------------------------------
test('mdToDoc: first H1 becomes title and TITLE style', () => {
  const { title, requests } = mdToDoc('# My Doc\n\nhello');
  assert.equal(title, 'My Doc');
  const titleReq = requests.find((r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'TITLE');
  assert.ok(titleReq, 'expected a TITLE paragraph style');
});

test('mdToDoc: explicit title overrides heading', () => {
  const { title } = mdToDoc('# Heading', { title: 'Override' });
  assert.equal(title, 'Override');
});

test('mdToDoc: single insertText carries the full body, index 1', () => {
  const { requests, text } = mdToDoc('# H\n\nbody text');
  const ins = requests.filter((r) => r.insertText);
  assert.equal(ins.length, 1);
  assert.equal(ins[0].insertText.location.index, 1);
  assert.equal(ins[0].insertText.text, text);
  assert.match(text, /^H\nbody text\n$/);
});

test('mdToDoc: text-style ranges land on the right characters', () => {
  const { requests, text } = mdToDoc('hello **world**');
  const bold = requests.find((r) => r.updateTextStyle?.textStyle?.bold);
  const { startIndex, endIndex } = bold.updateTextStyle.range;
  // index 1 == first char; slice back into the inserted text
  assert.equal(text.slice(startIndex - 1, endIndex - 1), 'world');
});

test('mdToDoc: unordered and ordered lists produce bullet requests', () => {
  const { requests } = mdToDoc('- a\n- b\n\n1. x\n2. y');
  const bullets = requests.filter((r) => r.createParagraphBullets);
  assert.equal(bullets.length, 2);
  assert.equal(bullets[0].createParagraphBullets.bulletPreset, 'BULLET_DISC_CIRCLE_SQUARE');
  assert.equal(bullets[1].createParagraphBullets.bulletPreset, 'NUMBERED_DECIMAL_ALPHA_ROMAN');
});

test('mdToDoc: table is deferred to an anchor + spec, not inline text', () => {
  const { tables, text } = mdToDoc('| A | B |\n| - | - |\n| 1 | 2 |');
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].rows, [['A', 'B'], ['1', '2']]);
  assert.ok(tables[0].anchorIndex >= 1);
  assert.ok(!text.includes('A'), 'table content should not be in the body text');
});

test('mdToDoc: heading styles map to HEADING_n below the title', () => {
  const { requests } = mdToDoc('# T\n\n## Sub\n\n### Deep');
  const named = requests.filter((r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType)
    .map((r) => r.updateParagraphStyle.paragraphStyle.namedStyleType);
  assert.deepEqual(named, ['TITLE', 'HEADING_2', 'HEADING_3']);
});

// --- request-shaping --------------------------------------------------------
test('splitLargeInserts: splits an oversized insert at cumulative indices', () => {
  const big = 'x'.repeat(250);
  const out = splitLargeInserts([{ insertText: { location: { index: 1 }, text: big } }], 100);
  assert.ok(out.length > 1);
  // pieces reassemble to the original, indices are contiguous
  let idx = 1;
  let joined = '';
  for (const r of out) {
    assert.equal(r.insertText.location.index, idx);
    idx += r.insertText.text.length;
    joined += r.insertText.text;
  }
  assert.equal(joined, big);
});

test('splitLargeInserts: leaves small inserts and other requests untouched', () => {
  const reqs = [
    { insertText: { location: { index: 1 }, text: 'small' } },
    { updateTextStyle: { range: { startIndex: 1, endIndex: 3 } } },
  ];
  assert.deepEqual(splitLargeInserts(reqs, 100), reqs);
});

test('rebaseIndices: shifts every index field by delta', () => {
  const reqs = [
    { insertText: { location: { index: 1 }, text: 'hi' } },
    { updateTextStyle: { range: { startIndex: 2, endIndex: 5 } } },
  ];
  const out = rebaseIndices(reqs, 10);
  assert.equal(out[0].insertText.location.index, 11);
  assert.equal(out[1].updateTextStyle.range.startIndex, 12);
  assert.equal(out[1].updateTextStyle.range.endIndex, 15);
  // original untouched
  assert.equal(reqs[0].insertText.location.index, 1);
});
