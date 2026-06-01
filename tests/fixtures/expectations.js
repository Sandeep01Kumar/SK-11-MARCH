/**
 * tests/fixtures/expectations.js
 * -----------------------------------------------------------------------------
 * SHARED TEST EXPECTATIONS — single source of truth for the black-box suite.
 *
 * Every expected value and parametrization array used by the four behavioral
 * test suites lives here, and ONLY here, so that no expected value is ever
 * hardcoded per-suite (AAP §0.4.4, §0.5.5, §0.10.3):
 *
 *   - tests/server.response.test.js  → BASE_URL, EXPECTED_BODY,
 *                                       EXPECTED_CONTENT_TYPE,
 *                                       EXPECTED_CONTENT_LENGTH
 *   - tests/server.edge.test.js      → METHODS, PATHS, BASE_URL, EXPECTED_BODY,
 *                                       EXPECTED_CONTENT_TYPE,
 *                                       EXPECTED_CONTENT_LENGTH
 *   - tests/server.error.test.js     → HOST, PORT
 *   - tests/server.lifecycle.test.js → STARTUP_BANNER, HOST, PORT
 *
 * These constants are derived from — and empirically verified against — the
 * REFERENCE system under test, `server.js` (repository root, byte-for-byte
 * immutable; AAP §0.10.1). `server.js` responds to EVERY method on EVERY path
 * with HTTP `200`, header `Content-Type: text/plain` (no charset suffix),
 * header `Content-Length: 14`, and body `Hello, World!\n`; it binds
 * `127.0.0.1:3000` and logs `Server running at http://127.0.0.1:3000/` exactly
 * once on startup.
 *
 * PURITY CONTRACT (AAP §0.10.1, §0.10.3):
 *   - CommonJS only (the repository declares no `"type": "module"`).
 *   - This module loads NOTHING and makes zero `require` calls. In particular
 *     it MUST NEVER load `server.js` or any sibling module: doing so would bind
 *     port 3000 as a load-time side effect and break the black-box design.
 *   - Zero side effects — declaring and exporting these literals is the file's
 *     entire behavior (no I/O, no logging, no network, no process access).
 *
 * TYPE NOTES (downstream suites use strict `===` / `toBe` / `deepStrictEqual`
 * comparisons, so types matter as much as values):
 *   - EXPECTED_CONTENT_LENGTH is the STRING `'14'`, not the number `14`,
 *     because Node returns HTTP header values as strings.
 *   - PORT is the NUMBER `3000`, not a string, because it is passed to
 *     `net.createConnection({ host, port })`.
 *   - STARTUP_BANNER is a RegExp object, not a string, because the lifecycle
 *     suite consumes it via `new RegExp(STARTUP_BANNER.source, 'g')` to count
 *     that the banner fires exactly once.
 */

'use strict';

module.exports = {
  // ---------------------------------------------------------------------------
  // Expected HTTP response — asserted by the response and edge suites for every
  // request, regardless of method or path (server.js ignores both).
  // ---------------------------------------------------------------------------

  // Exact response body. The trailing `\n` is REQUIRED: the literal is 14 bytes
  // (`Buffer.byteLength('Hello, World!\n') === 14`). Do NOT drop the newline.
  EXPECTED_BODY: 'Hello, World!\n',

  // Exact `Content-Type` header value — bare `text/plain` with NO
  // `; charset=...` suffix (empirically confirmed absent on server.js).
  EXPECTED_CONTENT_TYPE: 'text/plain',

  // Exact `Content-Length` header value as a STRING (`'14'`), matching how Node
  // surfaces header values. Suites compare `res.headers['content-length'] ===
  // EXPECTED_CONTENT_LENGTH`, so this must NOT be the number 14.
  EXPECTED_CONTENT_LENGTH: '14',

  // ---------------------------------------------------------------------------
  // Connection target — where the spawned `node server.js` child listens.
  // ---------------------------------------------------------------------------

  // Supertest base-URL target (no trailing slash): `request(BASE_URL).get('/')`.
  BASE_URL: 'http://127.0.0.1:3000',

  // Loopback host the server binds. Used as a string for raw `net` connections
  // and process-level error tests (ECONNREFUSED / EADDRINUSE).
  HOST: '127.0.0.1',

  // Hardcoded port the server binds. NUMBER (not string) — passed directly to
  // `net.createConnection({ host: HOST, port: PORT })`.
  PORT: 3000,

  // ---------------------------------------------------------------------------
  // Lifecycle — startup banner the server logs once on `listen`.
  // ---------------------------------------------------------------------------

  // RegExp (NOT a string) matching the exact startup banner printed to stdout:
  // `Server running at http://127.0.0.1:3000/`. Dots and slashes are escaped.
  // The lifecycle suite reuses `STARTUP_BANNER.source` with the global flag to
  // assert the banner fires exactly once.
  STARTUP_BANNER: /Server running at http:\/\/127\.0\.0\.1:3000\//,

  // ---------------------------------------------------------------------------
  // Parametrization arrays — drive the data-driven edge-case suite.
  // ---------------------------------------------------------------------------

  // Every HTTP method exercised by the edge suite. MUST include `'HEAD'`: the
  // edge suite both filters it out (`METHODS.filter(m => m !== 'HEAD')`) for the
  // body-bearing assertions and tests it separately for HEAD semantics
  // (headers present, empty body). Values are uppercase to mirror the wire
  // method names; suites lowercase them via `request(BASE_URL)[m.toLowerCase()]`.
  METHODS: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],

  // Representative request paths exercised by the edge suite to prove the
  // handler is path-agnostic. MUST include the query-string case `'/with?q=1'`
  // alongside root, a single segment, a deep nested path, and a trailing slash.
  PATHS: ['/', '/random', '/deep/nested/path', '/with?q=1', '/trailing/'],
};
