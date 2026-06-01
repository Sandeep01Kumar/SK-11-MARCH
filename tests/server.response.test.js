/**
 * tests/server.response.test.js
 * -----------------------------------------------------------------------------
 * HAPPY-PATH HTTP RESPONSE + HEADERS SUITE for the root `server.js` HTTP server.
 *
 * Scope (AAP §0.4.2, §0.5.2):
 *   - Status code  : every request resolves to HTTP `200` (and NEVER the
 *                    routing/method/error codes 404 / 405 / 500 — `server.js`
 *                    has no router, so those cannot appear; AAP §0.1.2).
 *   - Body         : the response body is EXACTLY `Hello, World!\n` — 14 bytes
 *                    INCLUDING the trailing newline (the `\n` is significant).
 *   - Headers      : `Content-Type: text/plain` (bare — NO `; charset=...`
 *                    suffix, empirically confirmed absent) and
 *                    `Content-Length: 14` (surfaced by Node as the STRING `'14'`).
 *
 * The PRIMARY test asserts status + body + BOTH headers together to maximize
 * assertion density (AAP §0.7.2); the granular tests that follow isolate each
 * observable property for clear, single-reason failure diagnostics.
 *
 * BLACK-BOX MANDATE (AAP §0.10.1): `server.js` binds 127.0.0.1:3000 as a
 * load-time side effect and exports nothing, so it is NEVER required in-process
 * (doing so would bind port 3000 with no handle to close and hang Jest on an
 * open handle). The server is launched as a REAL child process via
 * `tests/helpers/serverProcess.js` and exercised over real HTTP using Supertest
 * targeted at a base-URL string. No application internals are mocked — the
 * "test doubles" are a genuine OS process and loopback HTTP connections — so
 * `server.js` stays byte-for-byte unchanged (REFERENCE-only).
 *
 * SHARED LIFECYCLE (AAP §0.4.4, §0.10.3): this suite owns ONE server instance
 * for all of its tests via `beforeAll(startServer)` / `afterAll(stopServer)`.
 * Teardown is deterministic (SIGTERM + awaited exit) so port 3000 is released
 * and the suite is safe to run serially (`--runInBand`) alongside the other
 * port-3000-binding suites (lifecycle, error).
 *
 * Module style : CommonJS (the repository declares no `"type": "module"`).
 * Timeout      : the 15000 ms per-test budget is inherited from `jest.config.js`
 *                — it is intentionally NOT redefined here.
 * Fixtures     : every expected value comes from `tests/fixtures/expectations.js`
 *                — nothing is hardcoded in this suite, so the single source of
 *                truth governs all assertions.
 */

'use strict';

const request = require('supertest');
// This file lives at `tests/server.response.test.js`, so the shared helper and
// fixture modules in the sibling `tests/helpers/` and `tests/fixtures/`
// directories are reached with `./` specifiers (NOT `../`, which would point
// ABOVE the `tests/` directory to a non-existent repo-root `helpers/` and fail
// with MODULE_NOT_FOUND). The helper itself, living one level deeper in
// `tests/helpers/`, uses `../fixtures/expectations`; this suite, being one
// level shallower, uses `./`.
const { startServer, stopServer } = require('./helpers/serverProcess');
const {
  BASE_URL,
  EXPECTED_BODY,
  EXPECTED_CONTENT_TYPE,
  EXPECTED_CONTENT_LENGTH,
} = require('./fixtures/expectations');

describe('server.js HTTP responses', () => {
  // Handle to the spawned `node server.js` child process. Started once for the
  // whole suite (the handler is stateless, so a single instance serves every
  // test) and torn down deterministically so port 3000 is released for serial
  // (`--runInBand`) execution alongside the lifecycle/error suites.
  let server;

  // Launch `node server.js` and resolve only once its readiness banner has been
  // observed on stdout — guaranteeing the port is bound before any request is
  // issued, which eliminates startup race conditions.
  beforeAll(async () => {
    server = await startServer();
  });

  // Send SIGTERM and await the child's exit so no process or port leaks between
  // suites. `stopServer` is idempotent, so this is safe even if the process
  // already exited for some reason.
  afterAll(async () => {
    await stopServer(server);
  });

  // ---------------------------------------------------------------------------
  // 1. PRIMARY — full happy-path response asserted as a single coherent unit
  // ---------------------------------------------------------------------------
  // One request, four assertions: status, body, and BOTH deterministic headers.
  // This is the canonical contract of `server.js` (`200` / `text/plain` /
  // `Content-Length: 14` / `Hello, World!\n`) locked in one place.
  test('GET / returns a complete 200 text/plain response', async () => {
    const res = await request(BASE_URL).get('/');

    // Status line.
    expect(res.statusCode).toBe(200);
    // Body is byte-for-byte the greeting, including the trailing newline.
    expect(res.text).toBe(EXPECTED_BODY);
    // Content-Type is bare `text/plain` — no charset suffix.
    expect(res.headers['content-type']).toBe(EXPECTED_CONTENT_TYPE);
    // Content-Length is the string `'14'` (Node surfaces header values as
    // strings), matching the 14-byte body.
    expect(res.headers['content-length']).toBe(EXPECTED_CONTENT_LENGTH);
  });

  // ---------------------------------------------------------------------------
  // 2. STATUS CODE — exactly 200, never the routing/method/error codes
  // ---------------------------------------------------------------------------
  // `server.js` ignores `req.method` and `req.url`, so a conventional server's
  // 404 (unknown route), 405 (method not allowed), and 500 (server error)
  // CANNOT occur. Asserting both the positive (`=== 200`) and the explicit
  // absence of each negative code documents this inverted-routing behavior
  // (AAP §0.1.2).
  test('status code is exactly 200 (never 404/405/500)', async () => {
    const res = await request(BASE_URL).get('/');

    expect(res.statusCode).toBe(200);
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).not.toBe(405);
    expect(res.statusCode).not.toBe(500);
  });

  // ---------------------------------------------------------------------------
  // 3. BODY — exactly the 14-byte greeting (trailing newline included)
  // ---------------------------------------------------------------------------
  // Pins both the exact string and its byte length. `Buffer.byteLength` counts
  // UTF-8 bytes, so the explicit `14` guards against an accidental loss of the
  // trailing `\n` (which would silently shorten the body to 13 bytes).
  test('body is exactly the 14-byte greeting', async () => {
    const res = await request(BASE_URL).get('/');

    expect(res.text).toBe(EXPECTED_BODY);
    expect(Buffer.byteLength(res.text)).toBe(14);
  });

  // ---------------------------------------------------------------------------
  // 4. CONTENT-TYPE — bare `text/plain`, no charset
  // ---------------------------------------------------------------------------
  // Isolated so a Content-Type regression fails on its own with an unambiguous
  // message. The value must be exactly `text/plain` (no `; charset=utf-8`),
  // because `server.js` sets it via `res.setHeader('Content-Type', 'text/plain')`.
  test('Content-Type header is text/plain', async () => {
    const res = await request(BASE_URL).get('/');

    expect(res.headers['content-type']).toBe(EXPECTED_CONTENT_TYPE);
  });

  // ---------------------------------------------------------------------------
  // 5. CONTENT-LENGTH — the string `'14'`
  // ---------------------------------------------------------------------------
  // The runtime derives Content-Length from the static 14-byte body. HTTP
  // header values are strings, so this is compared against the STRING `'14'`,
  // not the number 14.
  test('Content-Length header is 14', async () => {
    const res = await request(BASE_URL).get('/');

    expect(res.headers['content-length']).toBe(EXPECTED_CONTENT_LENGTH);
  });
});
