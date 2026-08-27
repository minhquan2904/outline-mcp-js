#!/usr/bin/env node
'use strict';

/**
 * outline-mcp — read-only MCP access to an Outline wiki.
 *
 * Tools are declared as data in TOOLS and registered in a loop, so the test
 * suite can assert the surface and dispatch without opening a stdio transport.
 * Nothing here reads process.env: buildServer takes its dependencies, which
 * keeps env state from leaking between tests.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { createClient } = require('./client.js');
const {
  parseDocumentRef,
  formatSearchResults,
  formatTitleResults,
  formatDocument,
  formatRevision,
  formatList,
  absUrl,
} = require('./format.js');

const text = (t) => ({ content: [{ type: 'text', text: t }] });

const limit = (max, def) => z.number().int().min(1).max(max).default(def);
const offset = () => z.number().int().min(0).default(0);

/** Drop undefined optionals so the wire payload stays minimal. */
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** Every tool funnels through here: one call, one render, errors as content. */
async function fetchAndRender(deps, method, params, render) {
  const result = await deps.client.call(method, params);
  if (!result.ok) return text(result.error);
  return text(render(result.data, result.raw));
}

const TOOLS = [
  {
    name: 'search_documents',
    description:
      'Full-text search across your Outline wiki. Returns each hit as ' +
      'title, absolute URL and a matching snippet — NOT the full document body. ' +
      'Use this when you do not yet know which document you need. Once you have ' +
      'a URL or id, call get_document to read the body.',
    schema: {
      query: z.string().describe('Search terms'),
      collectionId: z.string().optional().describe('Restrict the search to one collection'),
      limit: limit(50, 10),
      offset: offset(),
      contextLimit: z.number().int().min(0).max(1000).default(200)
        .describe('Characters of surrounding context per hit'),
    },
    handler: (a, deps) =>
      fetchAndRender(deps, 'documents.search', compact(a),
        (data) => formatSearchResults(data, deps.baseUrl)),
  },
  {
    name: 'search_document_titles',
    description:
      'Search Outline document TITLES only. Cheaper and more precise than ' +
      'search_documents when you already know roughly what the page is called ' +
      'and only need to locate it. Returns titles and absolute URLs, no snippets.',
    schema: {
      query: z.string().describe('Words expected in the title'),
      limit: limit(50, 15),
    },
    handler: (a, deps) =>
      fetchAndRender(deps, 'documents.search_titles', compact(a),
        (data) => formatTitleResults(data, deps.baseUrl)),
  },
  {
    name: 'get_document',
    description:
      'Read one Outline document as markdown. Accepts a full document URL ' +
      '(https://host/doc/some-title-a1B2c3D4e5), a bare urlId, or a UUID. Long ' +
      'documents are truncated at maxChars with a marker stating the true total ' +
      'length — raise maxChars and call again if you need the rest.',
    schema: {
      idOrUrl: z.string().describe('Document URL, urlId, or UUID'),
      maxChars: z.number().int().min(0).max(400000).default(40000)
        .describe('Maximum characters of body to return'),
    },
    handler: (a, deps) => {
      const ref = parseDocumentRef(a.idOrUrl);
      // The instance answers 400 for a slug with no valid urlId suffix, so
      // there is nothing to gain from making the round trip.
      if (ref.kind === 'invalid') return Promise.resolve(text(ref.reason));
      return fetchAndRender(deps, 'documents.info', { id: ref.id },
        (data) => formatDocument(data, deps.baseUrl, a.maxChars));
    },
  },
  {
    name: 'list_collections',
    description:
      'List the collections (top-level spaces) in the Outline wiki. Use this ' +
      'first when you need to scope a search or browse, since collectionId is ' +
      'what search_documents and list_documents filter on.',
    schema: { limit: limit(100, 25), offset: offset() },
    handler: (a, deps) =>
      fetchAndRender(deps, 'collections.list', compact(a),
        (_data, raw) => formatList(raw, (c) => `${c.name}  [${c.id}]`)),
  },
  {
    name: 'list_documents',
    description:
      'Browse Outline documents without searching. Pass collectionId to list a ' +
      'collection, or parentDocumentId to walk into one document\'s children. ' +
      'Returns titles and absolute URLs only — call get_document to read one.',
    schema: {
      collectionId: z.string().optional().describe('List documents in this collection'),
      parentDocumentId: z.string().optional().describe('List children of this document'),
      limit: limit(100, 25),
      offset: offset(),
    },
    handler: (a, deps) =>
      fetchAndRender(deps, 'documents.list', compact(a),
        (_data, raw) => formatList(raw, (d) => `${d.title}\n   ${absUrl(deps.baseUrl, d.url)}`)),
  },
  {
    name: 'list_revisions',
    description:
      'List the saved revisions of one Outline document, newest first. Use this ' +
      'to see how a spec changed over time; pair it with get_revision to read a ' +
      'specific earlier version.',
    schema: {
      documentId: z.string().describe('UUID of the document'),
      limit: limit(50, 10),
      offset: offset(),
    },
    handler: (a, deps) =>
      fetchAndRender(deps, 'revisions.list', compact(a),
        (_data, raw) => formatList(raw, (r) => `${r.createdAt}  ${r.title}  [${r.id}]`)),
  },
  {
    name: 'get_revision',
    description:
      'Read one earlier version of an Outline document as markdown. Get the ' +
      'revision id from list_revisions first. Use this to diff what a spec said ' +
      'before against what it says now.',
    schema: {
      revisionId: z.string().describe('Revision id from list_revisions'),
      maxChars: z.number().int().min(0).max(400000).default(40000)
        .describe('Maximum characters of body to return'),
    },
    // Wire param is `id`; `revisionId` returns 400 on the live instance.
    handler: (a, deps) =>
      fetchAndRender(deps, 'revisions.info', { id: a.revisionId },
        (data) => formatRevision(data, a.maxChars)),
  },
  {
    name: 'list_comments',
    description:
      'List review comments left on one Outline document. Use this when a spec ' +
      'has open questions or reviewer pushback that is not reflected in the body ' +
      'text itself.',
    schema: {
      documentId: z.string().describe('UUID of the document'),
      limit: limit(100, 25),
      offset: offset(),
    },
    handler: (a, deps) =>
      fetchAndRender(deps, 'comments.list', compact(a),
        (_data, raw) => formatList(raw, (c) =>
          `${c.createdAt}  ${(c.createdBy && c.createdBy.name) || 'unknown'}  [${c.id}]`)),
  },
];

function buildServer(deps) {
  const server = new McpServer({ name: 'outline', version: '1.0.0' });
  for (const tool of TOOLS) {
    server.tool(tool.name, tool.description, tool.schema, (args) => tool.handler(args, deps));
  }
  return server;
}

function realDeps() {
  const baseUrl = process.env.OUTLINE_API_URL || '';
  return {
    baseUrl,
    client: createClient({ baseUrl, apiKey: process.env.OUTLINE_API_KEY || '' }),
  };
}

async function main() {
  // Deliberately no env validation here: a server that exits on boot shows up
  // as "failed to connect" with no reason. Missing config surfaces per call.
  await buildServer(realDeps()).connect(new StdioServerTransport());
  process.stderr.write('[outline] MCP server started (stdio transport)\n');
}

module.exports = { TOOLS, buildServer, realDeps };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[outline] Fatal: ${err && err.message}\n`);
    process.exit(1);
  });
}
