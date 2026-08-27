# Contributing

Thanks for contributing. This is a deliberately small server — please keep
new changes just as small.

## Requirements

- Node 18 or newer (the code relies on the built-in `fetch`).
- No other prerequisites for development; tests are fully offline.

## Running the tests

```bash
npm ci
npm test
```

The suite stubs `globalThis.fetch` per test and never touches the network.
All tests must pass before a pull request is ready for review.

## Running the smoke script

```bash
npm run smoke
```

`smoke.js` exercises every tool against a real Outline instance. It needs
`OUTLINE_API_URL` and `OUTLINE_API_KEY` set; without them it prints a
"smoke skipped" line and exits 0, so it is safe to run anywhere, including
CI without secrets. Use `--verbose` to print a sample document body.

## Adding a tool

Tools are declared as data in the `TOOLS` array in `index.js`. Each entry
needs:

- `name` — the tool name exposed to the client
- `description` — when to use it and when not to (the model picks tools by
  reading these)
- `schema` — a plain object of zod fields (use the shared `limit`/`offset`
  helpers for pagination)
- `handler` — funnel through `fetchAndRender(deps, method, params, render)`;
  `method` must be a real Outline API method name (`documents.search`,
  `revisions.list`, …), and `render` shapes the result with a helper from
  `format.js`

`buildServer` registers the whole array in a loop, and `tests/tools.test.js`
asserts the surface, so a new tool also needs a test entry there.

## Conventions

- CommonJS (`require`/`module.exports`), `'use strict'` at the top of every file.
- No new runtime dependencies without discussion — the only dependencies are
  the MCP SDK and zod, and both are load-bearing.
- Log to `process.stderr` only: stdout is the MCP stdio transport and any
  stray write to it corrupts the protocol.
