#!/usr/bin/env node
'use strict';

/**
 * smoke.js — exercise every tool against a real Outline instance.
 *
 * No-ops (exit 0) when credentials are absent so CI stays green without
 * secrets. Use --verbose for content.
 */

const { createClient } = require('./client.js');
const { TOOLS } = require('./index.js');
const { z } = require('zod');

const VERBOSE = process.argv.includes('--verbose');
const baseUrl = process.env.OUTLINE_API_URL || '';
const apiKey = process.env.OUTLINE_API_KEY || '';

if (!apiKey || !baseUrl) {
  const missing = [!baseUrl && 'OUTLINE_API_URL', !apiKey && 'OUTLINE_API_KEY'].filter(Boolean);
  console.log(`smoke skipped — ${missing.join(' and ')} not set.`);
  process.exit(0);
}

const deps = { baseUrl, client: createClient({ baseUrl, apiKey }) };
let failures = 0;

function report(label, ok, note = '') {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${note ? `  ${note}` : ''}`);
}

async function run(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  const out = await tool.handler(z.object(tool.schema).parse(args), deps);
  return out.content[0].text;
}

/** A tool "passed" when it did not come back as an error message. */
function looksOk(text) {
  return !/^\$?[A-Z_]*(is not set|Outline (rejected|refused|returned)|Not found|Could not reach)/i.test(text);
}

(async () => {
  const auth = await deps.client.call('auth.info', {});
  report('auth.info', auth.ok, auth.ok ? '' : auth.error);
  if (!auth.ok) process.exit(1);

  const collections = await run('list_collections', { limit: 3 });
  report('list_collections', looksOk(collections));

  const search = await deps.client.call('documents.search', { query: 'spec', limit: 1 });
  const hit = search.ok && search.data && search.data[0] && search.data[0].document;
  report('search_documents', Boolean(hit));
  if (!hit) process.exit(1);

  report('search_document_titles', looksOk(await run('search_document_titles', { query: 'spec', limit: 3 })));

  // AC3: the same document reached three different ways must be one document.
  const slug = String(hit.url).replace(/^\/doc\//, '');
  const forms = { UUID: hit.id, urlId: hit.urlId, 'slug-urlId': slug };
  const ids = {};
  for (const [label, ref] of Object.entries(forms)) {
    const res = await deps.client.call('documents.info', { id: ref });
    ids[label] = res.ok ? res.data.id : `ERR ${res.error}`;
    report(`get_document via ${label}`, res.ok);
  }
  const unique = new Set(Object.values(ids));
  report('all three identifier forms resolve to one document', unique.size === 1,
    unique.size === 1 ? '' : JSON.stringify(ids));

  report('list_documents (collection)', looksOk(await run('list_documents', { collectionId: hit.collectionId, limit: 3 })));
  report('list_documents (children)', looksOk(await run('list_documents', { parentDocumentId: hit.id, limit: 3 })));
  report('list_revisions', looksOk(await run('list_revisions', { documentId: hit.id, limit: 3 })));
  report('list_comments', looksOk(await run('list_comments', { documentId: hit.id, limit: 3 })));

  const body = await run('get_document', { idOrUrl: hit.id, maxChars: 200 });
  report('get_document truncates at maxChars', /truncated/.test(body) || body.length < 600);

  const bad = await run('get_document', { idOrUrl: 'khong-phai-gi-ca' });
  report('invalid reference rejected locally', /not a document reference/i.test(bad));

  if (VERBOSE) console.log(`\n--- get_document sample ---\n${body}`);

  console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`smoke crashed: ${err && err.message}`);
  process.exit(1);
});
