'use strict';

/**
 * tools.test.js — the MCP surface.
 *
 * Wire-level parameter names were confirmed against the live instance in
 * Phase 0. Two of them do NOT match the tool-facing names, which is exactly
 * the kind of mapping that rots silently:
 *   - get_document takes `idOrUrl`, sends `id`
 *   - get_revision takes `revisionId`, sends `id`   (revisionId is a 400)
 */

const test = require('node:test');
const assert = require('node:assert');
const { z } = require('zod');

const { TOOLS, buildServer } = require('../index.js');

const BASE = 'https://outline.example.com';
const UUID = '3f9a2c10-1b2c-4d5e-8f90-abcdef123456';
const URLID = 'a1B2c3D4e5';

const EXPECTED = [
  'search_documents',
  'search_document_titles',
  'get_document',
  'list_collections',
  'list_documents',
  'list_revisions',
  'get_revision',
  'list_comments',
  'create_document',
  'update_document',
  'move_document',
  'archive_document',
  'delete_document',
];

/** Records what the handler asked the client to do. */
function recorder(result = { ok: true, data: [] }) {
  const calls = [];
  return {
    calls,
    client: {
      call: async (method, params) => {
        calls.push({ method, params });
        return typeof result === 'function' ? result(method, params) : result;
      },
    },
  };
}

function byName(name) {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} is not registered`);
  return tool;
}

/** Run a tool the way the SDK would: zod-parse the args, then dispatch. */
async function invoke(name, args, deps) {
  const tool = byName(name);
  const parsed = z.object(tool.schema).parse(args);
  return tool.handler(parsed, deps);
}

// ── surface ───────────────────────────────────────────────────────────────

test('exposes exactly the tool set Phase 0 confirmed is reachable', () => {
  assert.deepStrictEqual(TOOLS.map((t) => t.name).sort(), [...EXPECTED].sort());
});

test('every tool has a description that says WHEN to use it', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description.length >= 40,
      `${tool.name}: description too thin to guide tool selection`);
  }
});

test('buildServer registers without credentials', () => {
  // A server that dies on boot surfaces as "failed to connect" with no reason.
  const server = buildServer({ client: recorder().client, baseUrl: '' });
  assert.ok(server, 'server must construct even with nothing configured');
});

// ── dispatch + wire mapping ───────────────────────────────────────────────

test('search_documents: applies documented defaults', async () => {
  const rec = recorder({ ok: true, data: [] });
  await invoke('search_documents', { query: 'spec' }, { client: rec.client, baseUrl: BASE });
  assert.deepStrictEqual(rec.calls[0], {
    method: 'documents.search',
    params: { query: 'spec', limit: 10, offset: 0, contextLimit: 200 },
  });
});

test('search_documents: passes collectionId through only when given', async () => {
  const rec = recorder({ ok: true, data: [] });
  await invoke('search_documents', { query: 'x', collectionId: 'col-1' },
    { client: rec.client, baseUrl: BASE });
  assert.strictEqual(rec.calls[0].params.collectionId, 'col-1');
});

test('get_document: a pasted URL is reduced to the urlId before the call', async () => {
  const rec = recorder({ ok: true, data: { id: UUID, urlId: URLID, url: `/doc/x-${URLID}`, text: 'hi' } });
  await invoke('get_document', { idOrUrl: `${BASE}/doc/my-spec-${URLID}` },
    { client: rec.client, baseUrl: BASE });
  assert.deepStrictEqual(rec.calls[0], { method: 'documents.info', params: { id: URLID } });
});

test('get_document: a UUID is forwarded untouched', async () => {
  const rec = recorder({ ok: true, data: { id: UUID, text: 'hi' } });
  await invoke('get_document', { idOrUrl: UUID }, { client: rec.client, baseUrl: BASE });
  assert.strictEqual(rec.calls[0].params.id, UUID);
});

test('get_document: an unparseable reference fails locally, sparing a known 400', async () => {
  const rec = recorder();
  const out = await invoke('get_document', { idOrUrl: 'khong-phai-gi-ca' },
    { client: rec.client, baseUrl: BASE });
  assert.strictEqual(rec.calls.length, 0, 'the instance would answer 400 — do not ask');
  assert.match(out.content[0].text, /not a document reference/i);
});

test('get_revision: sends `id`, because `revisionId` is a 400 upstream', async () => {
  const rec = recorder({ ok: true, data: { id: 'rev-1', documentId: UUID, text: 'body' } });
  await invoke('get_revision', { revisionId: 'rev-1' }, { client: rec.client, baseUrl: BASE });
  assert.deepStrictEqual(rec.calls[0], { method: 'revisions.info', params: { id: 'rev-1' } });
});

test('list_documents: forwards parentDocumentId for subtree browsing', async () => {
  const rec = recorder({ ok: true, data: [] });
  await invoke('list_documents', { parentDocumentId: UUID },
    { client: rec.client, baseUrl: BASE });
  assert.strictEqual(rec.calls[0].method, 'documents.list');
  assert.strictEqual(rec.calls[0].params.parentDocumentId, UUID);
});

test('list_revisions and list_comments both key off documentId', async () => {
  for (const [tool, method] of [['list_revisions', 'revisions.list'], ['list_comments', 'comments.list']]) {
    const rec = recorder({ ok: true, data: [] });
    await invoke(tool, { documentId: UUID }, { client: rec.client, baseUrl: BASE });
    assert.strictEqual(rec.calls[0].method, method);
    assert.strictEqual(rec.calls[0].params.documentId, UUID);
  }
});

// ── output discipline ─────────────────────────────────────────────────────

test('search_documents: renders absolute urls, never the raw document body', async () => {
  const CANARY = 'CANARY_FULL_BODY';
  const rec = recorder({
    ok: true,
    data: [{ context: 'snippet', ranking: 1, document: { id: UUID, title: 'T', url: `/doc/t-${URLID}`, text: CANARY } }],
  });
  const out = await invoke('search_documents', { query: 'x' }, { client: rec.client, baseUrl: BASE });
  const text = out.content[0].text;
  assert.ok(text.includes(`${BASE}/doc/t-${URLID}`), 'relative urls are dead links');
  assert.ok(!text.includes(CANARY), 'search must not dump full bodies');
});

test('get_document: honours maxChars and reports the real length', async () => {
  const rec = recorder({ ok: true, data: { id: UUID, urlId: URLID, url: `/doc/t-${URLID}`, title: 'T', text: 'q'.repeat(500) } });
  const out = await invoke('get_document', { idOrUrl: UUID, maxChars: 50 },
    { client: rec.client, baseUrl: BASE });
  assert.match(out.content[0].text, /500/);
});

// ── failure surfaces as content, never as a throw ─────────────────────────

test('a client error becomes readable content instead of an exception', async () => {
  const rec = recorder({ ok: false, error: '$OUTLINE_API_KEY is not set.' });
  const out = await invoke('search_documents', { query: 'x' }, { client: rec.client, baseUrl: BASE });
  assert.match(out.content[0].text, /OUTLINE_API_KEY/);
});

test('every tool survives an unconfigured client without throwing', async () => {
  const rec = recorder({ ok: false, error: 'not configured' });
  const args = {
    search_documents: { query: 'x' },
    search_document_titles: { query: 'x' },
    get_document: { idOrUrl: UUID },
    list_collections: {},
    list_documents: {},
    list_revisions: { documentId: UUID },
    get_revision: { revisionId: 'r' },
    list_comments: { documentId: UUID },
    create_document: { title: 't', collectionId: UUID },
    update_document: { documentId: UUID, text: 'x' },
    move_document: { documentId: UUID, collectionId: UUID },
    archive_document: { documentId: UUID },
    delete_document: { documentId: UUID },
  };
  for (const name of EXPECTED) {
    const out = await invoke(name, args[name], { client: rec.client, baseUrl: '' });
    assert.ok(out.content[0].text.length > 0, `${name} returned empty content`);
  }
});

// ── write tools ────────────────────────────────────────────────────────────

test('write tools have full rights when no restriction is set', async () => {
  const rec = recorder({ ok: true, data: { title: 'T', text: 'abc', url: '/doc/t-x' } });
  const deps = { client: rec.client, baseUrl: BASE };
  await invoke('create_document', { title: 'T', text: 'abc', collectionId: UUID }, deps);
  await invoke('update_document', { documentId: UUID, text: 'abc' }, deps);
  await invoke('move_document', { documentId: UUID, collectionId: UUID }, deps);
  await invoke('archive_document', { documentId: UUID }, deps);
  await invoke('delete_document', { documentId: UUID }, deps);
  assert.deepStrictEqual(rec.calls.map((c) => c.method),
    ['documents.create', 'documents.update', 'documents.move', 'documents.archive', 'documents.delete']);
  assert.deepStrictEqual(rec.calls[1].params, { id: UUID, text: 'abc', append: true });
});

test('update_document: accepts a pasted edit URL', async () => {
  const rec = recorder({ ok: true, data: { title: 'T', text: 'x', url: '/doc/t-x' } });
  await invoke('update_document', { documentId: `${BASE}/doc/benchmark-mcp-${URLID}/edit`, text: 'x' },
    { client: rec.client, baseUrl: BASE });
  assert.strictEqual(rec.calls[0].params.id, URLID);
});

test('OUTLINE_WRITE_DOC_ID confines writes to update_document on that document', async () => {
  const rec = recorder();
  const deps = { client: rec.client, baseUrl: BASE, writeDocId: UUID };
  const other = await invoke('update_document', { documentId: '11111111-2222-3333-4444-555555555555', text: 'x' }, deps);
  assert.match(other.content[0].text, /may only update/);
  const del = await invoke('delete_document', { documentId: UUID }, deps);
  assert.match(del.content[0].text, /writes are restricted/);
  const create = await invoke('create_document', { title: 't', collectionId: UUID }, deps);
  assert.match(create.content[0].text, /writes are restricted/);
  assert.strictEqual(rec.calls.length, 0);
});

test('OUTLINE_WRITE_DOC_ID given as a UUID still allows the same document by urlId', async () => {
  const rec = recorder((method) => method === 'documents.info'
    ? { ok: true, data: { id: UUID, urlId: URLID } }
    : { ok: true, data: { title: 'T', text: 'x', url: '/doc/t-x' } });
  const out = await invoke('update_document', { documentId: `${BASE}/doc/b-${URLID}/edit`, text: 'x' },
    { client: rec.client, baseUrl: BASE, writeDocId: UUID });
  assert.deepStrictEqual(rec.calls.map((c) => c.method), ['documents.info', 'documents.update']);
  assert.match(out.content[0].text, /^Updated/);
});

test('a urlId that resolves to a different document is refused', async () => {
  const rec = recorder({ ok: true, data: { id: '11111111-2222-3333-4444-555555555555', urlId: 'zzzzzzzzzz' } });
  const out = await invoke('update_document', { documentId: URLID, text: 'x' },
    { client: rec.client, baseUrl: BASE, writeDocId: UUID });
  assert.match(out.content[0].text, /may only update/);
  assert.deepStrictEqual(rec.calls.map((c) => c.method), ['documents.info']);
});
