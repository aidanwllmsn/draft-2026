/* index.html ships as one self-contained file, so lib/scoring.js is copied
 * into it verbatim rather than loaded with a <script src>. That duplication is
 * deliberate — but it means the app and this suite read different copies of the
 * same math, and nothing else would notice them drifting apart.
 *
 * lib/scoring.js is the source of truth. This test fails the moment the copy
 * baked into index.html stops matching it, so a change to the module that
 * isn't carried across cannot ship green. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/* Read as text and normalize line endings only. Every other byte is compared
 * exactly — the point of the test is that the copy is verbatim. */
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/* The final newline is left off the needle: it belongs to the file, not to the
 * block, and index.html is free to follow the copy with any whitespace. */
const MODULE = read('lib/scoring.js').replace(/\n$/, '');
const PAGE = read('index.html');

/* First line of the module — a distinctive banner comment we can anchor on to
 * report *where* the copies diverge instead of just that they do. */
const ANCHOR = MODULE.split('\n')[0];

test('index.html inlines lib/scoring.js verbatim', () => {
  assert.ok(MODULE.length > 0, 'lib/scoring.js is empty');

  if (PAGE.includes(MODULE)) return;

  /* Failed. Work out the most useful thing to say about why. */
  const at = PAGE.indexOf(ANCHOR);
  if (at === -1) {
    assert.fail(
      'index.html does not contain the inlined copy of lib/scoring.js at all.\n' +
      `Expected to find the module's opening line: ${JSON.stringify(ANCHOR)}\n` +
      'If the page went back to loading the module with <script src>, delete this test.'
    );
  }

  const want = MODULE.split('\n');
  const got = PAGE.slice(at).split('\n', want.length);
  const i = want.findIndex((line, n) => line !== got[n]);
  const lineInPage = PAGE.slice(0, at).split('\n').length + i;

  assert.fail(
    'The copy of lib/scoring.js inlined in index.html has drifted from the module.\n' +
    `First difference at lib/scoring.js line ${i + 1} (index.html line ${lineInPage}):\n` +
    `  lib/scoring.js: ${JSON.stringify(want[i])}\n` +
    `  index.html:     ${JSON.stringify(got[i])}\n` +
    'lib/scoring.js is the source of truth — re-copy it into index.html.'
  );
});

test('index.html inlines the module exactly once', () => {
  const first = PAGE.indexOf(ANCHOR);
  assert.notStrictEqual(first, -1, 'inlined copy not found');
  assert.strictEqual(
    PAGE.indexOf(ANCHOR, first + 1), -1,
    'index.html contains more than one copy of the scoring module — ' +
    'the drift guard can only keep one of them honest.'
  );
});
