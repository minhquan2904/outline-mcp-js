'use strict';

/**
 * client.js — Outline POST-RPC client.
 *
 * Outline exposes a flat RPC surface: every endpoint is POST {base}/api/{method}
 * with a JSON body and a Bearer token. That uniformity is why this whole server
 * needs one request function rather than a REST client.
 *
 * `call` NEVER throws. Tool handlers map its result straight to MCP content, so
 * every failure has to arrive as data with a message a human can act on.
 */

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRY_DELAY_MS = 10000;   // a 5-minute Retry-After reads as a hang
const FALLBACK_RETRY_MS = 1000;
const KEY_ENV = 'OUTLINE_API_KEY';
const URL_ENV = 'OUTLINE_API_URL';

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Strip the API key out of anything on its way to the caller. */
function redact(text, apiKey) {
  const s = String(text == null ? '' : text);
  if (!apiKey) return s;
  return s.split(apiKey).join('ol_api_***');
}

function endpoint(baseUrl, method) {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/api$/i, '');
  return `${base}/api/${method}`;
}

function retryDelayMs(response) {
  const raw = response.headers && response.headers.get('retry-after');
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return FALLBACK_RETRY_MS;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}

/**
 * Map an HTTP failure to a message that tells the reader what to do next.
 * Every method name this client sends was verified to exist during Phase 0,
 * so a 404 is always a missing resource — never a typo'd endpoint.
 */
function describeFailure(method, status, body) {
  const upstream = (body && (body.message || body.error)) || '';
  switch (status) {
    case 401:
      return `Outline rejected the credentials (401: ${upstream}). ` +
        `Check that $${KEY_ENV} holds a valid API key — create one under ` +
        'Settings → API & Apps in Outline.';
    case 403:
      return `Outline refused the request (403: ${upstream}). The key is valid ` +
        `but lacks permission for ${method}.`;
    case 404:
      return `Not found (404) for ${method}: ${upstream || 'the requested resource does not exist'}. ` +
        'The endpoint is valid, so the id or slug is the thing that missed.';
    case 429:
      return `Outline rate limit hit (429) on ${method} and the single retry ` +
        'also failed. Wait a moment and narrow the query before retrying.';
    default:
      return `Outline returned ${status} for ${method}: ${upstream || 'no message'}.`;
  }
}

function createClient({ baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, sleep = sleepReal }) {
  async function once(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(endpoint(baseUrl, method), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params || {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function readBody(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async function call(method, params) {
    // Fail before spending a request we already know cannot succeed.
    if (!baseUrl) {
      return { ok: false, error: `$${URL_ENV} is not set, so there is no Outline instance to call.` };
    }
    if (!apiKey) {
      return {
        ok: false,
        error: `$${KEY_ENV} is not set. Add it to ~/.claude/settings.json under "env" ` +
          '(create the key in Outline under Settings → API & Apps).',
      };
    }

    try {
      let response = await once(method, params);

      if (response.status === 429) {
        await sleep(retryDelayMs(response));
        response = await once(method, params);   // exactly one retry, never a loop
      }

      const body = await readBody(response);
      if (!response.ok) {
        return { ok: false, error: redact(describeFailure(method, response.status, body), apiKey) };
      }
      return { ok: true, data: body && body.data !== undefined ? body.data : body, raw: body };
    } catch (err) {
      const message = err && err.name === 'AbortError'
        ? `Request to Outline timed out after ${timeoutMs}ms on ${method}.`
        : `Could not reach Outline for ${method}: ${err && err.message}`;
      return { ok: false, error: redact(message, apiKey) };
    } finally {
      // stderr only — stdout belongs to the MCP stdio transport, and params can
      // carry document titles.
      process.stderr.write(`[outline] ${method}\n`);
    }
  }

  return { call };
}

module.exports = { createClient, redact, endpoint, KEY_ENV, URL_ENV };
