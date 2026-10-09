'use strict';

/**
 * format.js — pure parsing and rendering helpers. No I/O, no process.env.
 *
 * The constants here are measured, not guessed: Phase 0 probed the live
 * instance and found documents.info validates its `id` parameter BEFORE
 * checking auth, which let us map the accepted format exactly.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Measured boundary: 9 chars rejected, 10 accepted, 15 accepted, 16 rejected.
const URLID_RE = /^[A-Za-z0-9]{10,15}$/;

const REF_HINT =
  'expected a UUID, a 10-15 character urlId, or a document URL like /doc/title-a1B2c3D4e5';

/**
 * Resolve whatever the user pasted into an identifier documents.info accepts.
 * Returns {kind: 'uuid'|'urlId', id} or {kind: 'invalid', reason}.
 */
function parseDocumentRef(input) {
  if (typeof input !== 'string' || !input.trim()) {
    return { kind: 'invalid', reason: `Empty document reference — ${REF_HINT}.` };
  }
  const s = input.trim();

  // Must precede the dash rule: a UUID's own tail would satisfy URLID_RE.
  if (UUID_RE.test(s)) return { kind: 'uuid', id: s };

  const looksLikeUrl = /^https?:\/\//i.test(s) || s.startsWith('/');
  let segment;

  const docIdx = s.indexOf('/doc/');
  if (docIdx !== -1) {
    segment = s.slice(docIdx + '/doc/'.length);
  } else if (looksLikeUrl) {
    return { kind: 'invalid', reason: `"${s}" is not a document URL — ${REF_HINT}.` };
  } else {
    segment = s;
  }

  // Drop the query/hash and any sub-path such as /edit or /history.
  segment = segment.split(/[?#]/)[0].replace(/\/+$/, '');
  if (docIdx !== -1) segment = segment.split('/')[0];
  if (!segment) {
    return { kind: 'invalid', reason: `"${s}" has no document id — ${REF_HINT}.` };
  }

  const dash = segment.lastIndexOf('-');
  const candidate = dash === -1 ? segment : segment.slice(dash + 1);

  if (URLID_RE.test(candidate)) return { kind: 'urlId', id: candidate };

  return {
    kind: 'invalid',
    reason: `"${s}" is not a document reference — ${REF_HINT}.`,
  };
}

/**
 * Cut long bodies, always reporting the ORIGINAL length so the agent can
 * decide whether raising maxChars is worth another round trip.
 */
function truncate(text, maxChars) {
  const t = typeof text === 'string' ? text : '';
  const totalChars = t.length;
  if (totalChars <= maxChars) return { text: t, truncated: false, totalChars };
  const marker =
    `\n\n[... truncated — showing ${maxChars} of ${totalChars} characters. ` +
    'Call again with a larger maxChars to read the rest.]';
  return { text: t.slice(0, maxChars) + marker, truncated: true, totalChars };
}

/**
 * Outline returns document.url as a RELATIVE path ("/doc/title-6mck12gRJg").
 * Handing that to the agent verbatim produces dead links.
 */
function absUrl(baseUrl, path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  const base = (baseUrl || '').replace(/\/+$/, '');
  const rel = path.startsWith('/') ? path : `/${path}`;
  return base + rel;
}

const NO_RESULTS = 'No results.';

function docLine(doc, baseUrl, index) {
  return `${index + 1}. ${doc.title || '(untitled)'}\n   ${absUrl(baseUrl, doc.url)}`;
}

/** documents.search — hits are wrapped as {context, document, ranking}. */
function formatSearchResults(hits, baseUrl) {
  if (!Array.isArray(hits) || hits.length === 0) return NO_RESULTS;
  return hits
    .map((hit, i) => {
      const line = docLine(hit.document || {}, baseUrl, i);
      const ctx = (hit.context || '').trim();
      return ctx ? `${line}\n   ${ctx}` : line;
    })
    .join('\n\n');
}

/** documents.search_titles — returns bare document objects, no wrapper. */
function formatTitleResults(docs, baseUrl) {
  if (!Array.isArray(docs) || docs.length === 0) return NO_RESULTS;
  return docs.map((doc, i) => docLine(doc || {}, baseUrl, i)).join('\n');
}

function who(person, fallback) {
  return (person && person.name) || fallback || 'unknown';
}

function formatDocument(doc, baseUrl, maxChars) {
  const d = doc || {};
  const body = truncate(d.text, maxChars);
  const header = [
    `# ${d.title || '(untitled)'}`,
    `id: ${d.id} · urlId: ${d.urlId} · collection: ${d.collectionId}`,
    `url: ${absUrl(baseUrl, d.url)}`,
    `updated: ${d.updatedAt || 'unknown'} by ${who(d.updatedBy)}`,
  ].join('\n');
  return `${header}\n---\n${body.text}`;
}

function formatRevision(rev, maxChars) {
  const r = rev || {};
  const body = truncate(r.text, maxChars);
  const header = [
    `# ${r.title || '(untitled)'} (revision ${r.id})`,
    `document: ${r.documentId}`,
    `created: ${r.createdAt || 'unknown'} by ${who(r.createdBy, r.name)}`,
  ].join('\n');
  return `${header}\n---\n${body.text}`;
}

/** Generic list renderer that keeps the pagination cursor visible. */
function formatList(payload, renderItem) {
  const data = payload && payload.data;
  if (!Array.isArray(data) || data.length === 0) return NO_RESULTS;
  const lines = data.map((item, i) => `${i + 1}. ${renderItem(item)}`);
  const p = payload.pagination;
  if (p) {
    const parts = [`limit=${p.limit}`, `offset=${p.offset}`];
    if (p.total !== undefined) parts.push(`total=${p.total}`);
    lines.push('', `[${parts.join(' · ')}]`);
  }
  return lines.join('\n');
}

module.exports = {
  parseDocumentRef,
  truncate,
  absUrl,
  formatSearchResults,
  formatTitleResults,
  formatDocument,
  formatRevision,
  formatList,
  URLID_RE,
  UUID_RE,
};
