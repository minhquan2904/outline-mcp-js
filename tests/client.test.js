'use strict';

/**
 * client.test.js — HTTP contract for the Outline POST-RPC client.
 *
 * Nothing here touches the network: globalThis.fetch is stubbed per test.
 * The error envelope shapes asserted below were captured from the live
 * instance during Phase 0.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createClient } = require('../client.js');

const BASE = 'https://outline.example.com';
// Deliberately self-labelling: a secret scanner must be able to tell at a
// glance that this is a fixture, not a leaked credential.
const KEY = 'ol_api_TESTFIXTURE_NOT_A_REAL_KEY_00000000';

const realFetch = globalThis.fetch;
function stub(impl) {
  const calls = [];
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve(impl(calls.length, url, opts));
  };
  return calls;
}
function restore() {
  globalThis.fetch = realFetch;
}
test.afterEach(restore);

function res(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
const OK = res(200, { ok: true, data: { hello: 'world' } });

function client(overrides = {}) {
  return createClient({ baseUrl: BASE, apiKey: KEY, sleep: async () => {}, ...overrides });
}

// ── request builder ───────────────────────────────────────────────────────

test('call: POSTs to {base}/api/{method} with auth and JSON headers', async () => {
  const calls = stub(() => OK);
  await client().call('documents.search', { query: 'x', limit: 3 });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, `${BASE}/api/documents.search`);
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.strictEqual(calls[0].opts.headers.Authorization, `Bearer ${KEY}`);
  assert.strictEqual(calls[0].opts.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { query: 'x', limit: 3 });
});

test('call: unwraps data on success', async () => {
  stub(() => OK);
  const r = await client().call('auth.info', {});
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data, { hello: 'world' });
});

test('call: a trailing slash on baseUrl does not produce //api', async () => {
  const calls = stub(() => OK);
  await createClient({ baseUrl: `${BASE}/`, apiKey: KEY }).call('auth.info', {});
  assert.strictEqual(calls[0].url, `${BASE}/api/auth.info`);
});

test('call: a baseUrl that already ends in /api is not doubled', async () => {
  const calls = stub(() => OK);
  await createClient({ baseUrl: `${BASE}/api`, apiKey: KEY }).call('auth.info', {});
  assert.strictEqual(calls[0].url, `${BASE}/api/auth.info`);
});

// ── error mapping ─────────────────────────────────────────────────────────

test('401: names the env var the user actually has to set', async () => {
  stub(() => res(401, { ok: false, error: 'authentication_required', message: 'Authentication required' }));
  const r = await client().call('auth.info', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /OUTLINE_API_KEY/);
  assert.ok(!/\n\s+at /.test(r.error), 'no stack trace in a user-facing message');
});

test('403: reads as a permission problem, not a bad key', async () => {
  stub(() => res(403, { ok: false, error: 'permission_required', message: 'Permission required' }));
  const r = await client().call('documents.info', { id: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /permission/i);
  assert.ok(!/OUTLINE_API_KEY/.test(r.error), '403 is not a missing-credential problem');
});

test('404: blames the resource, since every method we call is verified', async () => {
  stub(() => res(404, { ok: false, error: 'not_found', message: 'Resource not found' }));
  const r = await client().call('documents.info', { id: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not found/i);
  assert.match(r.error, /documents\.info/, 'the caller needs to know which lookup missed');
});

test('500: surfaces the upstream status rather than swallowing it', async () => {
  stub(() => res(500, { ok: false, error: 'internal_error', message: 'boom' }));
  const r = await client().call('documents.list', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /500/);
});

test('call: a non-JSON body does not crash the client', async () => {
  stub(() => ({
    status: 502, ok: false,
    headers: { get: () => null },
    json: async () => { throw new SyntaxError('Unexpected token <'); },
    text: async () => '<html>bad gateway</html>',
  }));
  const r = await client().call('documents.list', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /502/);
});

// ── 429 handling ──────────────────────────────────────────────────────────

test('429: retries exactly once and then gives up', async () => {
  const calls = stub(() => res(429, { ok: false, error: 'rate_limit_exceeded' }, { 'retry-after': '2' }));
  const slept = [];
  const r = await createClient({
    baseUrl: BASE, apiKey: KEY, sleep: async (ms) => { slept.push(ms); },
  }).call('documents.search', { query: 'x' });

  assert.strictEqual(calls.length, 2, 'one retry — never a loop');
  assert.deepStrictEqual(slept, [2000], 'must honour Retry-After');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /rate limit/i);
});

test('429 then success: the retry result is returned', async () => {
  const calls = stub((n) => (n === 1 ? res(429, { ok: false }, { 'retry-after': '1' }) : OK));
  const r = await client().call('documents.search', { query: 'x' });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(r.ok, true);
});

test('429: an absurd Retry-After is capped, not obeyed', async () => {
  stub(() => res(429, { ok: false }, { 'retry-after': '300' }));
  const slept = [];
  await createClient({
    baseUrl: BASE, apiKey: KEY, sleep: async (ms) => { slept.push(ms); },
  }).call('documents.search', { query: 'x' });
  assert.deepStrictEqual(slept, [10000], 'a 5-minute stall would look like a hang');
});

test('429 without Retry-After: falls back to a sane delay', async () => {
  stub(() => res(429, { ok: false }));
  const slept = [];
  await createClient({
    baseUrl: BASE, apiKey: KEY, sleep: async (ms) => { slept.push(ms); },
  }).call('documents.search', { query: 'x' });
  assert.strictEqual(slept.length, 1);
  assert.ok(slept[0] > 0 && slept[0] <= 10000);
});

// ── timeout ───────────────────────────────────────────────────────────────

test('timeout: aborts and says so instead of hanging', async () => {
  globalThis.fetch = (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  const r = await createClient({ baseUrl: BASE, apiKey: KEY, timeoutMs: 5 })
    .call('documents.search', { query: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /timed out|timeout/i);
});

// ── missing credentials ───────────────────────────────────────────────────

test('missing key: returns an instruction and never touches the network', async () => {
  const calls = stub(() => OK);
  const r = await createClient({ baseUrl: BASE, apiKey: '' }).call('auth.info', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /OUTLINE_API_KEY/);
  assert.strictEqual(calls.length, 0, 'no point spending a request we know will 401');
});

test('missing baseUrl: same treatment, names its own env var', async () => {
  const calls = stub(() => OK);
  const r = await createClient({ baseUrl: '', apiKey: KEY }).call('auth.info', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /OUTLINE_API_URL/);
  assert.strictEqual(calls.length, 0);
});

test('call never throws — handlers can map the result straight to content', async () => {
  globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
  const r = await client().call('auth.info', {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(typeof r.error, 'string');
});

// ── redaction ─────────────────────────────────────────────────────────────

test('redaction: a key echoed back by the server never reaches the output', async () => {
  stub(() => res(400, { ok: false, error: 'validation_error', message: `bad token ${KEY} supplied` }));
  const r = await client().call('auth.info', {});
  assert.ok(!r.error.includes(KEY), 'the API key must never be echoed');
  assert.match(r.error, /ol_api_\*\*\*/);
});

test('redaction: applies to thrown network errors too', async () => {
  globalThis.fetch = () => Promise.reject(new Error(`connect failed for Bearer ${KEY}`));
  const r = await client().call('auth.info', {});
  assert.ok(!r.error.includes(KEY));
});
