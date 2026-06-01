/**
 * tests/server.edge.test.js
 * -----------------------------------------------------------------------------
 * EDGE-CASE SUITE for the root `server.js` HTTP server.
 *
 * Scope (AAP §0.4.2, §0.5.2):
 *   - Method-agnosticism : every non-HEAD method returns an IDENTICAL 200 + body
 *   - HEAD semantics      : 200 + headers but an EMPTY body (and, on Node, NO
 *                           `Content-Length` header — see the dedicated test)
 *   - Path-agnosticism    : every path (root, single segment, deep nested,
 *                           query string, trailing slash) returns the IDENTICAL
 *                           200 + body
 *   - Concurrency         : ~20 parallel GETs all return byte-identical responses
 *   - Determinism         : repeated sequential requests are byte-identical
 *
 * INVERTED ROUTING (AAP §0.1.2): `server.js` ignores `req.method` and `req.url`
 * entirely, so the classic "unknown route → 404" / "unsupported method → 405"
 * edge cases are INVERTED here. The correct assertion is the ABSENCE of 404/405
 * and the PRESENCE of an identical 200 for ANY method on ANY path.
 *
 * HEAD NUANCE (empirically verified): a `HEAD` request returns `200` and
 * `Content-Type: text/plain` but with an EMPTY body and NO `Content-Length`
 * header (Node omits it on HEAD). HEAD is therefore EXCLUDED from the generic
 * body-bearing method loop and asserted in its own dedicated test that does NOT
 * assert `Content-Length`.
 *
 * BLACK-BOX MANDATE (AAP §0.10.1): `server.js` binds 127.0.0.1:3000 as a
 * load-time side effect and exports nothing, so it is NEVER required in-process
 * (doing so would leak an unclosable handle and hang Jest). It is launched as a
 * REAL child process via `tests/helpers/serverProcess.js` and exercised over
 * real HTTP using Supertest. No application internals are mocked.
 *
 * Module style : CommonJS (the repository declares no `"type": "module"`).
 * Timeout      : the 15000 ms per-test budget is inherited from `jest.config.js`.
 * Fixtures     : all expected values and parametrization arrays come from
 *                `tests/fixtures/expectations.js` — nothing is hardcoded here, so
 *                adding a method/path later requires no edit to this file.
 */

'use strict';

const request = require('supertest');
// Relative to this file at `tests/server.edge.test.js`, the shared helper and
// fixture modules live in the sibling `tests/helpers/` and `tests/fixtures/`
// directories — hence the `./` specifiers (NOT `../`, which would point above
// the `tests/` directory). The helper itself (in `tests/helpers/`) uses
// `../fixtures/expectations`; this suite, being one level shallower, uses `./`.
const { startServer, stopServer } = require('./helpers/serverProcess');
const {
  METHODS,
  PATHS,
  BASE_URL,
  EXPECTED_BODY,
  EXPECTED_CONTENT_TYPE,
  EXPECTED_CONTENT_LENGTH,
} = require('./fixtures/expectations');

describe('server.js edge cases', () => {
  // Handle to the spawned `node server.js` child process. Started once for the
  // whole suite and torn down deterministically so port 3000 is released for
  // serial (`--runInBand`) execution alongside the lifecycle/error suites.
  let server;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await stopServer(server);
  });

  // ---------------------------------------------------------------------------
  // 1. METHOD-AGNOSTICISM (data-driven over every non-HEAD method)
  // ---------------------------------------------------------------------------
  // HEAD is deliberately excluded here because its response carries no body
  // (and no Content-Length) — it is asserted separately below. Every remaining
  // method must produce a byte-for-byte identical 200 response, since the
  // handler never inspects `req.method`. Supertest's per-method functions are
  // lowercase (`get`, `post`, `put`, `delete`, `patch`, `options`), so the
  // uppercase wire name from the fixture is lowercased before dispatch.
  describe.each(METHODS.filter((method) => method !== 'HEAD'))(
    '%s /',
    (method) => {
      test('returns an identical 200 + body (never 404/405)', async () => {
        const res = await request(BASE_URL)[method.toLowerCase()]('/');

        // Status is always 200 …
        expect(res.statusCode).toBe(200);
        // … and never the routing / method-rejection codes a conventional
        // server would emit. server.js has no router, so these cannot appear
        // (inverted-routing assertion — AAP §0.1.2).
        expect(res.statusCode).not.toBe(404);
        expect(res.statusCode).not.toBe(405);

        // Body and content headers are identical regardless of method.
        expect(res.text).toBe(EXPECTED_BODY);
        expect(res.headers['content-type']).toBe(EXPECTED_CONTENT_TYPE);
        expect(res.headers['content-length']).toBe(EXPECTED_CONTENT_LENGTH);
      });
    }
  );

  // ---------------------------------------------------------------------------
  // 2. HEAD SEMANTICS (dedicated test — body-bearing assertions do NOT apply)
  // ---------------------------------------------------------------------------
  // A HEAD response echoes the status and Content-Type of the equivalent GET
  // but MUST NOT include a message body. For this handler, Node also omits the
  // Content-Length header on the HEAD response, so Content-Length is
  // intentionally NOT asserted here (asserting it would fail — it is absent).
  test('HEAD / returns 200 + headers with an EMPTY body', async () => {
    const res = await request(BASE_URL).head('/');

    expect(res.statusCode).toBe(200);
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).not.toBe(405);
    expect(res.headers['content-type']).toBe(EXPECTED_CONTENT_TYPE);

    // No body on HEAD: Supertest surfaces this as either '' or undefined.
    expect(res.text === '' || res.text === undefined).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 3. PATH-AGNOSTICISM (data-driven over representative paths)
  // ---------------------------------------------------------------------------
  // Root, a single segment, a deep nested path, a query string (`/with?q=1`),
  // and a trailing slash must ALL resolve to the IDENTICAL 200 + body — the
  // handler never reads `req.url`, so no path is special and none yields a 404.
  test.each(PATHS)(
    'GET %s returns an identical 200 + body',
    async (path) => {
      const res = await request(BASE_URL).get(path);

      expect(res.statusCode).toBe(200);
      expect(res.statusCode).not.toBe(404);
      expect(res.text).toBe(EXPECTED_BODY);
      expect(res.headers['content-type']).toBe(EXPECTED_CONTENT_TYPE);
      expect(res.headers['content-length']).toBe(EXPECTED_CONTENT_LENGTH);
    }
  );

  // ---------------------------------------------------------------------------
  // 4. CONCURRENCY (~20 parallel GETs are all byte-identical)
  // ---------------------------------------------------------------------------
  // Fired in parallel via Promise.all to confirm the handler holds no mutable
  // shared state and serves every connection identically under simultaneous load.
  test('~20 concurrent parallel GETs all return an identical 200 + body', async () => {
    const CONCURRENCY = 20;

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => request(BASE_URL).get('/'))
    );

    expect(results).toHaveLength(CONCURRENCY);
    results.forEach((res) => {
      expect(res.statusCode).toBe(200);
      expect(res.text).toBe(EXPECTED_BODY);
      expect(res.headers['content-type']).toBe(EXPECTED_CONTENT_TYPE);
      expect(res.headers['content-length']).toBe(EXPECTED_CONTENT_LENGTH);
    });

    // Every response body is byte-identical → exactly one distinct value across
    // all concurrent responses.
    expect(new Set(results.map((res) => res.text)).size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 5. DETERMINISM (repeated sequential requests are byte-identical)
  // ---------------------------------------------------------------------------
  // Issued strictly sequentially (await inside the loop) to prove the response
  // does not drift across invocations — the handler is stateless.
  test('repeated sequential requests are byte-identical', async () => {
    const ITERATIONS = 10;
    const observed = [];

    for (let i = 0; i < ITERATIONS; i += 1) {
      // Sequential, not parallel: each request completes before the next begins.
      const res = await request(BASE_URL).get('/');
      observed.push({ status: res.statusCode, body: res.text });
    }

    expect(observed).toHaveLength(ITERATIONS);
    observed.forEach((sample) => {
      expect(sample.status).toBe(200);
      expect(sample.body).toBe(EXPECTED_BODY);
    });

    // Collapse to distinct (status, body) pairs — determinism implies exactly
    // one unique pair across every iteration.
    const distinct = new Set(observed.map((sample) => `${sample.status}:${sample.body}`));
    expect(distinct.size).toBe(1);
  });
});
