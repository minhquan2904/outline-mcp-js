'use strict';

/**
 * format.test.js — pure formatting/parsing helpers.
 *
 * Every boundary asserted here was measured against a live Outline instance
 * during development, not inferred from the public docs:
 *   - documents.info accepts "a valid UUID or slug"
 *   - urlId is [A-Za-z0-9]{10,15}, inclusive on both ends
 *   - document.url comes back RELATIVE ("/doc/title-6mck12gRJg")
 *   - documents.search wraps hits in {context, document, ranking};
 *     documents.search_titles returns bare document objects
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  parseDocumentRef,
  truncate,
  absUrl,
  formatSearchResults,
  formatTitleResults,
  formatDocument,
  formatRevision,
  formatList,
} = require('../format.js');

const BASE = 'https://outline.example.com';
const UUID = '3f9a2c10-1b2c-4d5e-8f90-abcdef123456';
const URLID = 'a1B2c3D4e5'; // 10 chars — the shortest accepted

// ── A. parseDocumentRef ───────────────────────────────────────────────────

test('parseDocumentRef: UUID is recognised before the dash-splitting rule', () => {
  // A UUID's own tail ("abcdef123456") would pass the urlId regex, so the
  // UUID branch has to win or every UUID degrades into a bogus urlId.
  assert.deepStrictEqual(parseDocumentRef(UUID), { kind: 'uuid', id: UUID });
});

test('parseDocumentRef: bare urlId at both length boundaries', () => {
  assert.deepStrictEqual(parseDocumentRef('a1B2c3D4e5'), { kind: 'urlId', id: 'a1B2c3D4e5' });
  assert.deepStrictEqual(parseDocumentRef('a1B2c3D4e5F6g7H'), { kind: 'urlId', id: 'a1B2c3D4e5F6g7H' });
});

test('parseDocumentRef: rejects just outside the measured urlId boundary', () => {
  for (const bad of ['a1B2c3D4e', 'a1B2c3D4e5F6g7H8', 'a1B2c', 'x']) {
    assert.strictEqual(parseDocumentRef(bad).kind, 'invalid', `${bad} must be invalid`);
  }
});

test('parseDocumentRef: full URL, path, and slug-less URL all yield the urlId', () => {
  const cases = [
    `${BASE}/doc/my-spec-${URLID}`,
    `/doc/my-spec-${URLID}`,
    `${BASE}/doc/${URLID}`,
    `${BASE}/doc/ten-co-dau-tieng-viet-${URLID}`,
  ];
  for (const input of cases) {
    assert.deepStrictEqual(parseDocumentRef(input), { kind: 'urlId', id: URLID }, input);
  }
});

test('parseDocumentRef: strips query string and hash', () => {
  assert.deepStrictEqual(parseDocumentRef(`${BASE}/doc/my-spec-${URLID}?ref=x#heading`),
    { kind: 'urlId', id: URLID });
});

test('parseDocumentRef: bare slug-urlId without a host still parses', () => {
  // Real shape people paste from the sidebar.
  assert.deepStrictEqual(parseDocumentRef(`dev-spec-${URLID}`),
    { kind: 'urlId', id: URLID });
});

test('parseDocumentRef: slug with no valid urlId suffix is rejected client-side', () => {
  // Proven against the live instance: {"id":"khong-phai-gi-ca"} returns
  // 400 validation_error. Failing fast beats spending a round trip on a 400.
  const r = parseDocumentRef('khong-phai-gi-ca');
  assert.strictEqual(r.kind, 'invalid');
  assert.match(r.reason, /UUID|urlId/i);
});

test('parseDocumentRef: dash suffix shorter than the boundary is rejected', () => {
  assert.strictEqual(parseDocumentRef(`${BASE}/doc/my-spec-abcdefgh`).kind, 'invalid');
  assert.strictEqual(parseDocumentRef(`${BASE}/doc/my-spec-abc`).kind, 'invalid');
});

test('parseDocumentRef: non-/doc/ URLs are rejected', () => {
  assert.strictEqual(parseDocumentRef(`${BASE}/search?query=x`).kind, 'invalid');
  assert.strictEqual(parseDocumentRef(`${BASE}/collection/${URLID}`).kind, 'invalid');
});

test('parseDocumentRef: empty and non-string input never throws', () => {
  for (const bad of ['', null, undefined, 42, {}, []]) {
    assert.strictEqual(parseDocumentRef(bad).kind, 'invalid', String(bad));
  }
});

test('parseDocumentRef: invalid results always carry a usable reason', () => {
  const r = parseDocumentRef('');
  assert.strictEqual(typeof r.reason, 'string');
  assert.ok(r.reason.length > 10, 'reason must be actionable, not a bare code');
});

// ── B. truncate ───────────────────────────────────────────────────────────

test('truncate: leaves short text untouched', () => {
  const r = truncate('hello', 100);
  assert.deepStrictEqual(r, { text: 'hello', truncated: false, totalChars: 5 });
});

test('truncate: does not cut at exactly the limit', () => {
  const s = 'x'.repeat(50);
  const r = truncate(s, 50);
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.text, s);
});

test('truncate: cuts one char over the limit and reports the true total', () => {
  const s = 'y'.repeat(51);
  const r = truncate(s, 50);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.totalChars, 51, 'totalChars must be the ORIGINAL length');
  assert.ok(r.text.startsWith('y'.repeat(50)));
  assert.match(r.text, /51/, 'the marker must state the true total');
});

test('truncate: maxChars of 0 truncates everything without throwing', () => {
  const r = truncate('abc', 0);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.totalChars, 3);
});

test('truncate: null/undefined text is treated as empty', () => {
  assert.strictEqual(truncate(null, 10).text, '');
  assert.strictEqual(truncate(undefined, 10).totalChars, 0);
});

// ── C. absUrl ─────────────────────────────────────────────────────────────

test('absUrl: joins a relative Outline path onto the base', () => {
  assert.strictEqual(absUrl(BASE, `/doc/x-${URLID}`), `${BASE}/doc/x-${URLID}`);
});

test('absUrl: a trailing slash on the base does not double up', () => {
  assert.strictEqual(absUrl(`${BASE}/`, `/doc/x-${URLID}`), `${BASE}/doc/x-${URLID}`);
});

test('absUrl: an already-absolute url passes through', () => {
  const abs = `${BASE}/doc/x-${URLID}`;
  assert.strictEqual(absUrl(BASE, abs), abs);
});

test('absUrl: missing base still yields the path rather than "undefined/..."', () => {
  assert.strictEqual(absUrl('', `/doc/x-${URLID}`), `/doc/x-${URLID}`);
});

// ── D. search formatters (two distinct upstream shapes) ───────────────────

const CANARY = 'CANARY_FULL_BODY';

const searchHit = {
  ranking: 0.9,
  context: 'the matching …snippet…',
  document: {
    id: UUID, urlId: URLID, title: 'Dev Spec',
    url: `/doc/dev-spec-${URLID}`, text: `intro ${CANARY} outro`,
  },
};

test('formatSearchResults: shows title, absolute url and context', () => {
  const out = formatSearchResults([searchHit], BASE);
  assert.match(out, /Dev Spec/);
  assert.match(out, /the matching …snippet…/);
  assert.ok(out.includes(`${BASE}/doc/dev-spec-${URLID}`));
});

test('formatSearchResults: never leaks the full document body', () => {
  // One search of 10 hits would otherwise swallow the whole context window.
  const out = formatSearchResults([searchHit, searchHit], BASE);
  assert.ok(!out.includes(CANARY), 'document.text must not reach the model here');
});

test('formatSearchResults: emits no bare relative /doc/ links', () => {
  const out = formatSearchResults([searchHit], BASE);
  assert.ok(!/(^|\s)\/doc\//.test(out), 'relative links are dead links for the agent');
});

test('formatSearchResults: empty list is a message, not a crash', () => {
  const out = formatSearchResults([], BASE);
  assert.match(out, /no result/i);
});

test('formatTitleResults: reads bare documents, not hit wrappers', () => {
  // documents.search_titles returns the document object directly — feeding it
  // through formatSearchResults would read .document of undefined.
  const out = formatTitleResults([searchHit.document], BASE);
  assert.match(out, /Dev Spec/);
  assert.ok(out.includes(`${BASE}/doc/dev-spec-${URLID}`));
  assert.ok(!out.includes(CANARY));
});

test('formatTitleResults: empty list is a message', () => {
  assert.match(formatTitleResults([], BASE), /no result/i);
});

// ── E. document / revision / list ─────────────────────────────────────────

const doc = {
  id: UUID, urlId: URLID, title: 'Dev Spec', collectionId: 'col-1',
  url: `/doc/dev-spec-${URLID}`, updatedAt: '2026-08-01T10:00:00Z',
  updatedBy: { name: 'Someone' }, text: '# Body\n\ncontent here',
};

test('formatDocument: header carries every field the agent needs to navigate', () => {
  const out = formatDocument(doc, BASE, 40000);
  for (const needle of [UUID, URLID, 'col-1', '2026-08-01', 'Someone', 'Dev Spec']) {
    assert.ok(out.includes(needle), `header must include ${needle}`);
  }
  assert.ok(out.includes(`${BASE}/doc/dev-spec-${URLID}`), 'url must be absolute');
});

test('formatDocument: body follows the header separator', () => {
  const out = formatDocument(doc, BASE, 40000);
  const [header, ...rest] = out.split('\n---\n');
  assert.ok(!header.includes('content here'));
  assert.ok(rest.join('\n---\n').includes('content here'));
});

test('formatDocument: a missing updatedBy does not throw', () => {
  const out = formatDocument({ ...doc, updatedBy: undefined }, BASE, 40000);
  assert.match(out, /unknown/i);
});

test('formatDocument: long bodies are truncated and say so', () => {
  const out = formatDocument({ ...doc, text: 'z'.repeat(500) }, BASE, 100);
  assert.match(out, /500/, 'must state the true total length');
  assert.ok(!out.includes('z'.repeat(200)));
});

test('formatRevision: renders the shape the live API actually returns', () => {
  const rev = {
    id: 'rev-1', documentId: UUID, title: 'Dev Spec', name: 'Someone',
    createdAt: '2026-08-01T10:00:00Z', createdBy: { name: 'Someone' },
    text: 'revision body',
  };
  const out = formatRevision(rev, 40000);
  assert.ok(out.includes('rev-1'));
  assert.ok(out.includes(UUID));
  assert.ok(out.includes('revision body'));
});

test('formatList: echoes pagination so the agent can page on its own', () => {
  const payload = {
    data: [{ id: 'c1', name: 'Engineering' }],
    pagination: { limit: 25, offset: 0, total: 2 },
  };
  const out = formatList(payload, (c) => `${c.id} ${c.name}`);
  assert.match(out, /Engineering/);
  assert.match(out, /limit/i);
  assert.match(out, /\b2\b/, 'total must survive into the output');
});

test('formatList: empty data is a message, not a crash', () => {
  assert.match(formatList({ data: [] }, (x) => String(x)), /no result/i);
  assert.match(formatList({}, (x) => String(x)), /no result/i);
});
